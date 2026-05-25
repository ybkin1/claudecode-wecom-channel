/**
 * 会话管理 — 内存存储，TTL 过期
 *
 * 参考：clawrelay-wecom-server/src/core/session_manager.py
 *
 * 会话 key 规则：
 * - 群聊: `group:<chatid>:<user_id>` — 每人独立线程
 * - 私聊: `private:<user_id>`
 *
 * 每个会话维护一个 messages 数组（对话历史），2h 无活动自动过期。
 */

class SessionManager {
  constructor({ ttlMs = 2 * 60 * 60 * 1000 } = {}) {
    this._sessions = new Map(); // key → { messages, lastActive, createdAt }
    this._ttlMs = ttlMs;
    this._cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000); // 每 5min 清理
  }

  /**
   * 获取会话（不存在则创建）
   */
  getSession(key) {
    this._cleanupExpired();
    let session = this._sessions.get(key);
    if (!session) {
      session = {
        messages: [],
        createdAt: Date.now(),
        lastActive: Date.now(),
      };
      this._sessions.set(key, session);
    }
    session.lastActive = Date.now();
    return session;
  }

  /**
   * 添加消息到会话历史
   */
  addMessage(key, role, content, userId = '', userName = '') {
    const session = this.getSession(key);
    session.messages.push({ role, content, userId, userName });
    // 限制历史长度，防止上下文过长
    if (session.messages.length > 50) {
      session.messages = session.messages.slice(-40);
    }
  }

  /**
   * 获取完整消息列表（含 system prompt）
   */
  getMessages(key, systemPrompt = '') {
    const session = this.getSession(key);
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'user', content: systemPrompt });
      messages.push({ role: 'assistant', content: '好的，我理解了。' });
    }
    messages.push(...session.messages);
    return messages;
  }

  /**
   * 重置会话
   */
  resetSession(key) {
    this._sessions.delete(key);
  }

  /**
   * 生成会话 key
   * - 群聊: group:<chatid>:<user_id> — 每人独立线程
   * - 私聊: private:<user_id>
   */
  static makeKey(chatType, identifier, userId = '') {
    if (chatType === 'group') {
      return `group:${identifier}:${userId}`;
    }
    return `private:${identifier}`;
  }

  /**
   * 统计信息
   */
  getStats() {
    return {
      total: this._sessions.size,
      oldest: this._sessions.size > 0
        ? Math.min(...[...this._sessions.values()].map(s => s.createdAt))
        : null,
    };
  }

  // ─── 内部方法 ───

  _cleanupExpired() {
    const now = Date.now();
    for (const [key, session] of this._sessions) {
      if (now - session.lastActive > this._ttlMs) {
        this._sessions.delete(key);
      }
    }
  }

  _cleanup() {
    const before = this._sessions.size;
    this._cleanupExpired();
    const after = this._sessions.size;
    if (before !== after) {
      console.log(`🧹 会话清理: ${before} → ${after} (清理 ${before - after} 个)`);
    }
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    this._sessions.clear();
  }
}

module.exports = { SessionManager };
