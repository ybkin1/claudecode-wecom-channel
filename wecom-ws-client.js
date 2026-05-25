/**
 * 企业微信 WebSocket 客户端
 *
 * 参考：clawrelay-wecom-server/src/transport/ws_client.py
 *
 * 功能：
 * - 连接 wss://openws.work.weixin.qq.com
 * - 发送 aibot_subscribe 认证
 * - 心跳保活（30s）
 * - 接收消息（aibot_msg_callback / aibot_event_callback）
 * - 发送回复（aibot_send_msg）
 * - 断线自动重连（指数退避）
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

class WeComWsClient extends EventEmitter {
  constructor(config) {
    super();
    this.botId = config.botId;
    this.secret = config.secret;
    this.wsUrl = config.wsUrl;
    this.heartbeatInterval = config.heartbeatInterval || 30000;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;

    this._ws = null;
    this._heartbeatTimer = null;
    this._reconnectCount = 0;
    this._running = false;
    this._pendingRequests = new Map();
  }

  async connect() {
    this._running = true;
    await this._doConnect();
  }

  async disconnect() {
    this._running = false;
    this._clearHeartbeat();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  async _doConnect() {
    if (!this._running) return;

    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.wsUrl, {
        headers: { 'User-Agent': 'WeComAiBotNodeSDK/1.0' },
      });

      this._ws.on('open', () => {
        console.log('✅ WebSocket 已连接');
        this.emit('connect');
        this._subscribe();
      });

      this._ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }

        const reqId = msg.headers?.req_id || '';

        // 1. 检查是否是 pending 请求的响应
        if (reqId && this._pendingRequests.has(reqId)) {
          const pending = this._pendingRequests.get(reqId);
          this._pendingRequests.delete(reqId);
          pending.resolve(msg);
          return;
        }

        // 2. 分发回调
        const cmd = msg.cmd;
        if (cmd === 'aibot_msg_callback') {
          this.emit('message', msg.body);
        } else if (cmd === 'aibot_event_callback') {
          this.emit('event', msg.body);
        }
      });

      this._ws.on('error', (err) => {
        console.error('❌ WebSocket 错误:', err.message);
        if (this._ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });

      this._ws.on('close', (code) => {
        this.emit('disconnect', code);
        this._clearHeartbeat();
        if (this._running) {
          this._reconnect();
        }
      });
    });
  }

  async _subscribe() {
    const reqId = this._genId();
    const payload = {
      cmd: 'aibot_subscribe',
      headers: { req_id: reqId },
      body: { bot_id: this.botId, secret: this.secret },
    };

    try {
      const resp = await this._sendAndWait(payload, reqId, 10000);
      if (resp.errcode !== 0) {
        throw new Error(`订阅失败: errcode=${resp.errcode}, errmsg=${resp.errmsg}`);
      }
      console.log('✅ 认证成功，启动心跳...');
      this._reconnectCount = 0;
      this._startHeartbeat();
    } catch (e) {
      console.error('❌ 认证失败:', e.message);
      throw e;
    }
  }

  async sendReply(chatId, msgType, content) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }

    const reqId = this._genId();
    const payload = {
      cmd: 'aibot_send_msg',
      headers: { req_id: reqId },
      body: {
        chatid: chatId,
        msgtype: msgType,
        markdown: { content },
      },
    };

    console.log(`[WS] sendReply: cmd=aibot_send_msg, reqId=${reqId}, chatid=${chatId.substring(0, 12)}, content_len=${content.length}`);

    try {
      const result = await this._sendAndWait(payload, reqId, 10000);
      console.log(`[WS] sendReply 响应: errcode=${result.errcode}`);
      return result;
    } catch (e) {
      console.error(`[WS] sendReply 失败: ${e.message}`);
      throw e;
    }
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeatTimer = setInterval(async () => {
      try {
        const reqId = this._genId();
        await this._sendAndWait({
          cmd: 'ping',
          headers: { req_id: reqId },
        }, reqId, 10000);
      } catch (e) {
        console.error('⚠️ 心跳失败:', e.message);
        this._ws?.close();
      }
    }, this.heartbeatInterval);
  }

  _clearHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async _reconnect() {
    if (this._ws) {
      this._ws.removeAllListeners();
      this._ws = null;
    }

    this._reconnectCount++;
    if (this._reconnectCount > this.maxReconnectAttempts) {
      console.error(`❌ 重连次数过多 (${this._reconnectCount})，停止重连`);
      this._running = false;
      return;
    }

    const delay = Math.min(2 ** this._reconnectCount * 1000, 60000);
    console.log(`🔄 ${delay}ms 后重连 (第 ${this._reconnectCount} 次)...`);
    await this._sleep(delay);

    try {
      await this._doConnect();
    } catch (e) {
      // _doConnect reject 会在 _ws.on('error') 中处理
    }
  }

  _sendAndWait(payload, reqId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(reqId);
        reject(new Error('请求超时'));
      }, timeoutMs);

      this._pendingRequests.set(reqId, { resolve, reject, timer });

      this._ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          clearTimeout(timer);
          this._pendingRequests.delete(reqId);
          reject(err);
        }
      });
    });
  }

  _genId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = { WeComWsClient };
