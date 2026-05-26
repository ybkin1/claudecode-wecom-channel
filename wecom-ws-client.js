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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

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
        // 捕获认证异常，防止 unhandled rejection
        this._subscribe().catch(e => {
          console.error('❌ 认证异常:', e.message);
          // 认证失败则关闭连接触发重连
          this._ws?.close();
        });
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

  /**
   * 发送回复消息（按 msgType 构造不同 body 结构）
   *
   * @param {string} chatId — 会话 ID
   * @param {string} msgType — 消息类型: 'markdown' | 'image' | 'file'
   * @param {string|Object} content — markdown 文本 / media_id 字符串 或 { media_id } 对象
   */
  async sendReply(chatId, msgType, content) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }

    const reqId = this._genId();

    // 按 msgType 构造不同 body
    const body = { chatid: chatId, msgtype: msgType };

    switch (msgType) {
      case 'markdown':
        body.markdown = { content };
        break;
      case 'image':
        // content 为 media_id 字符串 或 { media_id } 对象
        body.image = { media_id: typeof content === 'string' ? content : (content.media_id || content) };
        break;
      case 'file':
        // content 为 media_id 字符串 或 { media_id } 对象
        body.file = { media_id: typeof content === 'string' ? content : (content.media_id || content) };
        break;
      default:
        // 未知类型回退到 markdown
        body.msgtype = 'markdown';
        body.markdown = { content: String(content) };
        break;
    }

    const payload = {
      cmd: 'aibot_send_msg',
      headers: { req_id: reqId },
      body,
    };

    var contentPreview = typeof content === 'string' ? content.substring(0, 60) : JSON.stringify(content).substring(0, 60);
    console.log('[WS] sendReply: cmd=aibot_send_msg, reqId=' + reqId + ', chatid=' + chatId.substring(0, 12) + ', msgType=' + msgType + ', preview="' + contentPreview + '"');

    try {
      const result = await this._sendAndWait(payload, reqId, 10000);
      console.log('[WS] sendReply 响应: errcode=' + result.errcode);
      return result;
    } catch (e) {
      console.error('[WS] sendReply 失败: ' + e.message);
      throw e;
    }
  }

  /**
   * 通过 WebSocket 三阶段协议上传媒体文件
   *
   * 协议流程（全部走 WebSocket 通道，无需 HTTP API / access_token）：
   *   1. aibot_upload_media_init  → 获得 upload_id
   *   2. aibot_upload_media_chunk → 每块 512KB 逐块上传
   *   3. aibot_upload_media_finish → 获得 media_id
   *
   * @param {string} filePath — 本地文件路径
   * @param {string} [mediaType='file'] — 媒体类型: 'image' | 'file' | 'voice' | 'video'
   * @returns {Promise<{ media_id: string, filename: string, fileSize: number, mediaType: string }>}
   */
  async uploadMedia(filePath, mediaType) {
    if (!mediaType) mediaType = 'file';

    var stat = fs.statSync(filePath);
    var filename = path.basename(filePath);
    var fileSize = stat.size;

    console.log('[WS] uploadMedia: 开始上传 ' + filename + ' (' + fileSize + ' bytes, type=' + mediaType + ')');

    // Step 1: 初始化上传
    var initResp = await this._sendUploadCommand('aibot_upload_media_init', {
      filename: filename,
      filesize: fileSize,
      mediatype: mediaType,
    });
    var uploadId = initResp.upload_id || (initResp.body && initResp.body.upload_id);
    if (!uploadId) {
      throw new Error('upload_media_init 未返回 upload_id: ' + JSON.stringify(initResp));
    }
    console.log('[WS] uploadMedia: init 完成, upload_id=' + uploadId);

    // Step 2: 分块上传（每块 512KB）
    var CHUNK_SIZE = 512 * 1024; // 512 KB
    var fileBuffer = fs.readFileSync(filePath);
    var totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    for (var i = 0; i < totalChunks; i++) {
      var start = i * CHUNK_SIZE;
      var end = Math.min(start + CHUNK_SIZE, fileSize);
      var chunk = fileBuffer.slice(start, end);
      var base64Chunk = chunk.toString('base64');

      await this._sendUploadCommand('aibot_upload_media_chunk', {
        upload_id: uploadId,
        chunk: base64Chunk,
        chunk_index: i,
      });
      // 进度日志（每 10 块或最后一块）
      if ((i + 1) % 10 === 0 || (i + 1) === totalChunks) {
        console.log('[WS] uploadMedia: chunk ' + (i + 1) + '/' + totalChunks + ' 完成');
      }
    }

    // Step 3: 完成上传，获取 media_id
    var finishResp = await this._sendUploadCommand('aibot_upload_media_finish', {
      upload_id: uploadId,
    });
    var mediaId = finishResp.media_id || (finishResp.body && finishResp.body.media_id);
    if (!mediaId) {
      throw new Error('upload_media_finish 未返回 media_id: ' + JSON.stringify(finishResp));
    }
    console.log('[WS] uploadMedia: 完成, media_id=' + mediaId);

    return { media_id: mediaId, filename: filename, fileSize: fileSize, mediaType: mediaType };
  }

  /**
   * 发送上传类 WebSocket 命令并等待响应（专用封装，60s 超时）
   */
  async _sendUploadCommand(cmd, body) {
    var reqId = this._genId();
    var payload = {
      cmd: cmd,
      headers: { req_id: reqId },
      body: body,
    };
    return this._sendAndWait(payload, reqId, 60000);
  }

  /**
   * 下载媒体文件（HTTP GET → 写入本地文件）
   *
   * 用于从 WeCom 回调 URL 下载图片/文件
   *
   * @param {string} url — 下载 URL
   * @param {string} destPath — 目标文件路径
   * @returns {Promise<void>}
   */
  downloadMedia(url, destPath) {
    var self = this;
    return new Promise(function(resolve, reject) {
      var parsedUrl = new URL(url);
      var client = parsedUrl.protocol === 'https:' ? https : http;

      var options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { 'User-Agent': 'WeComAiBot/1.0' },
      };

      var req = client.request(options, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          self.downloadMedia(res.headers.location, destPath).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }

        var fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);

        fileStream.on('finish', function() {
          fileStream.close();
          console.log('[WS] downloadMedia: ' + destPath + ' 下载完成');
          resolve();
        });

        fileStream.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(30000, function() {
        req.destroy();
        reject(new Error('下载超时 (30s)'));
      });

      req.end();
    });
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
