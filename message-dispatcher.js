/**
 * 消息分发器 — 接收 WeCom 消息，路由到 Claude，流式回复
 *
 * 参考：clawrelay-wecom-server/src/transport/message_dispatcher.py
 *
 * 功能：
 * - 消息去重
 * - 群聊 @ 过滤（只在被 @ 时回复）
 * - 指令解析（/help, /reset, /clear）
 * - 流式推送（节流）
 * - 错误处理
 */

const { SessionManager } = require('./session-manager.js');
const { ConcurrencyLimiter } = require('./concurrency-limiter.js');

// 内置指令
const COMMANDS = {
  '/help': {
    description: '显示帮助信息',
    handler: () => COMMAND_RESPONSES.help,
  },
  '/reset': {
    description: '重置当前会话（清除对话历史）',
    handler: (sessionKey, sessionManager) => {
      sessionManager.resetSession(sessionKey);
      return COMMAND_RESPONSES.reset;
    },
  },
  '/clear': {
    description: '同 /reset',
    handler: (sessionKey, sessionManager) => {
      sessionManager.resetSession(sessionKey);
      return COMMAND_RESPONSES.reset;
    },
  },
  '/status': {
    description: '显示服务状态',
    handler: () => COMMAND_RESPONSES.status,
  },
};

const COMMAND_RESPONSES = {
  help: `📖 **yb_claudecode 帮助**

我是你的 AI 助手，支持以下指令：

• \`/help\` — 显示帮助
• \`/reset\` 或 \`/clear\` — 重置会话
• \`/status\` — 服务状态

**群聊：** @我 即可对话
**私聊：** 直接发消息

开始对话吧！`,

  reset: `✅ 会话已重置，对话历史已清除。`,

  status: `📊 **服务状态**

✅ WebSocket: 已连接
✅ Claude API: 正常
✅ 会话管理: 运行中`,
};

class MessageDispatcher {
  constructor(wsClient, orchestrator, config) {
    this.wsClient = wsClient;
    this.orchestrator = orchestrator;
    this.config = config;

    // 消息去重（防止重复处理）
    this._processedMsgIds = new Map(); // msgId → timestamp
    this._msgDedupTtl = 30000; // 30s 去重窗口

    // 活跃处理锁（同一会话同时只处理一条消息）
    this._processingSessions = new Set();

    // 节流定时器
    this._throttleTimers = new Map();

    // 发送冷却（防止同内容重复发送）
    this._lastSendTime = new Map(); // chatId → timestamp
    this._lastSendContent = new Map(); // chatId → content hash
    this._sendCooldownMs = 3000; // 3s 冷却窗口

    // 入站消息内容去重（WeCom 可能用不同 msgid 发相同内容）
    this._recentInbound = new Map(); // "chattype+from+hash" → timestamp
    this._inboundDedupWindow = 10000; // 10s 内容去重窗口

    // 并发控制器
    this._concurrencyLimiter = new ConcurrencyLimiter({
      maxConcurrent: config.maxConcurrent || 3,
      queueSize: config.queueSize || 50,
    });

    console.log('📨 消息分发器已初始化');
  }

  /**
   * 处理 aibot_msg_callback 消息
   */
  async handleMessage(body) {
    const { msgid, chattype, from, msgtype, chatid, text, create_time } = body;

    console.log(`📨 收到消息: msgid=${msgid?.substring(0, 12) || 'N/A'}, chattype=${chattype}, from=${from?.userid}`);

    // 去重检查
    if (msgid && this._isDuplicate(msgid)) {
      console.log(`🔁 跳过重复消息: msgid=${msgid.substring(0, 12)}`);
      return;
    }

    // 白名单检查
    const userId = from?.userid || 'unknown';
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(userId)) {
      console.log(`⛔ 用户 ${userId} 不在白名单，忽略`);
      return;
    }

    // 消息类型路由
    if (msgtype === 'text') {
      const content = text?.content || '';
      if (!content.trim()) return;

      // 群聊 @ 过滤
      if (chattype === 'group') {
        // 检查是否 @ 了机器人
        if (!this._isAtBot(content)) {
          return; // 不是 @ 机器人，忽略
        }
        // 去除 @提及
        const cleanContent = this._removeAtMention(content);

        // 入站内容去重：WeCom 可能用不同 msgid 发相同内容
        if (this._isDuplicateInbound(chattype, userId, cleanContent)) {
          console.log(`🔁 跳过重复入站消息: user=${userId}, content_preview="${cleanContent.substring(0, 30)}"`);
          return;
        }

        await this._dispatchText(userId, cleanContent, 'group', chatid, msgid);
      } else {
        // 私聊
        if (!this.config.privateChatEnabled) return;

        // 私聊也做内容去重
        if (this._isDuplicateInbound(chattype, userId, content)) {
          console.log(`🔁 跳过重复入站消息: user=${userId}, content_preview="${content.substring(0, 30)}"`);
          return;
        }

        await this._dispatchText(userId, content, 'private', userId, msgid);
      }
    } else {
      console.log(`⚠️ 不支持的消息类型: ${msgtype}`);
      this._sendReply(chatid || userId, `⚠️ 暂不支持 ${msgtype} 类型消息`);
    }
  }

  /**
   * 处理 aibot_event_callback 事件
   */
  async handleEvent(body) {
    const eventType = body?.event?.eventtype || '';
    console.log(`📌 收到事件: ${eventType}`);

    if (eventType === 'enter_chat') {
      // 用户进入会话，发欢迎语
      const userId = body?.from?.userid;
      const chatId = body?.chatid;
      if (userId) {
        console.log(`👋 用户 ${userId} 进入会话`);
      }
    }
  }

  // ─── 内部方法 ───

  async _dispatchText(userId, content, chatType, identifier, msgId) {
    const sessionKey = SessionManager.makeKey(chatType, identifier, userId);

    // 并发锁：同一会话同时只处理一条消息
    if (this._processingSessions.has(sessionKey)) {
      console.log(`⏳ 会话 ${sessionKey} 正在处理中，跳过`);
      return;
    }

    this._processingSessions.add(sessionKey);

    try {
      // 检查指令
      const commandResult = this._checkCommand(content.trim(), sessionKey);
      if (commandResult) {
        await this._sendReply(identifier, commandResult);
        return;
      }

      // 流式回复
      await this._concurrencyLimiter.submit(
        () => this._streamReply(userId, content, sessionKey, identifier, chatType),
        { userId, sessionKey, chatType }
      );
    } catch (err) {
      console.error(`[Dispatcher] 处理失败: ${err.message}`);
      if (err.message.includes("队列已满")) {
        await this._sendReply(identifier, "当前请求较多，请稍后再试");
      } else {
        await this._sendReply(identifier, "处理失败，请稍后再试");
      }
    } finally {
      this._processingSessions.delete(sessionKey);
    }
  }

  async _streamReply(userId, content, sessionKey, chatId, chatType) {
    const mentionPrefix = (chatType === "group") ? "" : "";
    const startTime = Date.now();
    let lastPushTime = 0;
    let accumulatedText = '';
    let isFinished = false;

    // 流式回调 — 节流推送
    const onStreamDelta = async (text, finished) => {
      accumulatedText = text;
      isFinished = finished;
      const now = Date.now();

      // 节流
      if (now - lastPushTime < this.config.streamThrottleMs) return;
      lastPushTime = now;

      await this._pushStream(chatId, (chatType === "group" ? "@" + userId + " " : "") + accumulatedText, isFinished);
    };

    try {
      const result = await this.orchestrator.handleMessage(
        userId,
        userId, // userName
        content,
        sessionKey,
        onStreamDelta
      );

      // 确保最后一条推送
      if (!isFinished) {
        await this._pushStream(chatId, (chatType === "group" ? "@" + userId + " " : "") + accumulatedText, true);
      }

      const latency = Date.now() - startTime;
      console.log(`[Dispatcher] 回复完成: chatId=${chatId}, latency=${latency}ms`);

    } catch (err) {
      // 错误统一由 _dispatchText 处理，此处只负责抛出
      // 避免重复发送错误消息给用户
      throw err;
    }
  }

  async _pushStream(chatId, text, finished) {
    const shortText = text.substring(0, 80).replace(/\n/g, ' ');
    console.log(`[Push] chatId=${chatId.substring(0, 12)}, finished=${finished}, len=${text.length}, preview="${shortText}..."`);

    // 发送冷却：防止短时间内发送相同内容
    if (this._isDuplicateSend(chatId, text)) {
      console.log(`⏭️ 跳过重复发送: chatId=${chatId.substring(0, 12)}`);
      return;
    }

    // 截断过长的消息（企业微信 markdown 限制 4096 字节）
    let displayText = text;
    if (Buffer.byteLength(displayText, 'utf8') > 4000) {
      // 简单截断
      let truncated = '';
      for (let i = 0; i < displayText.length; i++) {
        if (Buffer.byteLength(truncated + displayText[i], 'utf8') > 3950) break;
        truncated += displayText[i];
      }
      displayText = truncated + '\n\n> （内容过长，已截断）';
    }

    try {
      console.log(`[Send] 调用 wsClient.sendReply: chatId=${chatId.substring(0, 12)}, type=markdown`);
      await this.wsClient.sendReply(chatId, 'markdown', displayText);
      console.log(`[Send] wsClient.sendReply 完成`);
      this._recordSend(chatId, text);
    } catch (e) {
      console.error(`[Dispatcher] 推送失败: ${e.message}`);
    }
  }

  async _sendReply(chatId, text) {
    // 发送冷却
    if (this._isDuplicateSend(chatId, text)) {
      console.log(`⏭️ 跳过重复发送: chatId=${chatId.substring(0, 12)}`);
      return;
    }

    try {
      await this.wsClient.sendReply(chatId, 'markdown', text);
      this._recordSend(chatId, text);
    } catch (e) {
      console.error(`[Dispatcher] 发送失败: ${e.message}`);
    }
  }

  _checkCommand(text, sessionKey) {
    for (const [cmd, handler] of Object.entries(COMMANDS)) {
      if (text.toLowerCase() === cmd) {
        console.log(`📝 执行指令: ${cmd}`);
        return handler.handler(sessionKey, this.orchestrator.sessionManager);
      }
    }
    return null;
  }

  _isAtBot(content) {
    console.log('[DEBUG _isAtBot] botName=' + JSON.stringify(this.config.botName) + ', content_preview=' + content.substring(0, 50));
    if (!this.config.botName) return true; // 没有配置名字，不过滤
    // 匹配 @yb_claudecode 等
    const atPattern = new RegExp(`@${this.config.botName}`);
    return atPattern.test(content);
  }

  _removeAtMention(content) {
    if (!this.config.botName) return content;
    // 去除 @机器人名字
    const atPattern = new RegExp(`@${this.config.botName}\\s*`, 'g');
    return content.replace(atPattern, '').trim();
  }

  _isDuplicate(msgId) {
    const now = Date.now();
    if (this._processedMsgIds.has(msgId)) {
      return true;
    }
    this._processedMsgIds.set(msgId, now);

    // 清理过期记录
    for (const [id, ts] of this._processedMsgIds) {
      if (now - ts > this._msgDedupTtl) {
        this._processedMsgIds.delete(id);
      }
    }
    return false;
  }

  /**
   * 检查是否重复发送（相同 chatId + 相似内容 + 短时间）
   */
  _isDuplicateSend(chatId, text) {
    const now = Date.now();
    const lastTime = this._lastSendTime.get(chatId);
    const lastContent = this._lastSendContent.get(chatId);

    if (lastTime && (now - lastTime) < this._sendCooldownMs) {
      // 短内容直接比较，长内容比较 hash
      const short = text.length < 200;
      if (short && lastContent === text) return true;
      if (!short && lastContent && this._hash(text) === this._hash(lastContent)) return true;
    }
    return false;
  }

  /**
   * 记录发送
   */
  _recordSend(chatId, text) {
    this._lastSendTime.set(chatId, Date.now());
    // 只保存短内容的原文，长内容保存 hash
    this._lastSendContent.set(chatId, text.length < 200 ? text : this._hash(text));
  }

  /**
   * 简单 hash（短文本用）
   */
  _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return h;
  }

  /**
   * 入站消息内容去重（防止 WeCom 用不同 msgid 发相同内容）
   */
  _isDuplicateInbound(chattype, userId, content) {
    const now = Date.now();
    const key = `${chattype}:${userId}:${this._hash(content)}`;
    const lastSeen = this._recentInbound.get(key);

    if (lastSeen && (now - lastSeen) < this._inboundDedupWindow) {
      return true; // 10s 内相同用户+相同内容 = 重复
    }

    this._recentInbound.set(key, now);

    // 清理过期记录
    for (const [k, ts] of this._recentInbound) {
      if (now - ts > this._inboundDedupWindow) {
        this._recentInbound.delete(k);
      }
    }

    return false;
  }
}

module.exports = { MessageDispatcher };
