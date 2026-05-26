
// 全局异常处理 — 防止 unhandledRejection 导致静默崩溃
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message);
  process.exit(1);
});

/**
 * Claude ↔ 企业微信 双向聊天代理
 *
 * 架构参考：
 * - clawrelay-wecom-server (Python): WebSocket 长连接 + 消息分发 + 会话管理
 * - openclaw-plugin-wecom (JS): 流式输出 + 群聊/私聊隔离 + 指令系统
 *
 * 架构：
 *   企业微信用户发消息 → WebSocket 接收 → Anthropic API → Claude 回复 → WebSocket 流式推送
 *
 * 特性：
 * - WebSocket 长连接（30s 心跳，断线自动重连）
 * - 流式回复（300ms 节流推送）
 * - 会话管理（2h 自动过期）
 * - 群聊 + 私聊支持
 * - 指令系统（/help, /reset, /clear）
 * - 安全过滤（防身份伪造）
 *
 * 用法：node .claude/tasks/tk-20260525-001/artifacts/wecom-chat-agent/main.js
 *
 * 依赖：npm install @anthropic-ai/sdk ws
 */

const { WeComWsClient } = require('./wecom-ws-client.js');
const { ClaudeOrchestrator } = require('./claude-orchestrator.js');
const { MessageDispatcher } = require('./message-dispatcher.js');
const { SessionManager } = require('./session-manager.js');
const { FileBroker } = require('./file-broker.js');
const { loadConfig } = require('./config.js');

// ─── 启动入口 ───

let wsClient;
let _fileBroker; // 供信号处理器引用

async function main() {
  const config = loadConfig();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Claude ↔ 企业微信 双向聊天代理                   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🤖 机器人: ${config.botId.substring(0, 10)}...`);
  console.log(`📡 WeCom: ${config.wsUrl}`);
  console.log(`🧠 Claude API: ${config.apiBase || 'default'}`);
  console.log(`💬 模型: ${config.model}`);
  console.log(` 并发: max=${config.maxConcurrent || 3}, queue=${config.queueSize || 50}`);
  console.log(`🧹 沙箱: ${config.sandboxDir} (TTL=${(config.fileTtlMs/1000).toFixed(0)}s, maxSize=${(config.maxFileSize/1024/1024).toFixed(0)}MB)`);
  console.log('');

  // 初始化核心组件
  const sessionManager = new SessionManager({ ttlMs: 2 * 60 * 60 * 1000 }); // 2h 过期
  const orchestrator = new ClaudeOrchestrator(config, sessionManager);
  wsClient = new WeComWsClient(config);

  // 初始化 FileBroker（安全文件读写沙箱）
  const fileBrokerOptions = {
    sandboxDir: config.sandboxDir,
    fileTtlMs: config.fileTtlMs,
    maxFileSize: config.maxFileSize,
  };
  if (config.allowedFileExtensions) {
    fileBrokerOptions.allowedExtensions = config.allowedFileExtensions;
  }
  const fileBroker = new FileBroker(fileBrokerOptions);

  const dispatcher = new MessageDispatcher(wsClient, orchestrator, config, fileBroker);
  _fileBroker = fileBroker; // 保留引用供信号处理器使用

  // 绑定回调
  wsClient.on('message', (msg) => dispatcher.handleMessage(msg));
  wsClient.on('event', (evt) => dispatcher.handleEvent(evt));
  wsClient.on('connect', () => console.log('✅ WebSocket 已连接，等待消息...'));
  wsClient.on('disconnect', (code) => console.log(`🔌 连接已关闭 (code=${code})`));

  // 启动连接
  console.log('📡 正在连接企业微信...');
  await wsClient.connect();
}


process.on('SIGINT', () => {
  console.log('[Shutdown] 收到 SIGINT，正在关闭...');
  if (_fileBroker) _fileBroker.cleanupAll();
  if (typeof wsClient !== "undefined" && wsClient) wsClient.disconnect();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('[Shutdown] 收到 SIGTERM，正在关闭...');
  if (_fileBroker) _fileBroker.cleanupAll();
  if (typeof wsClient !== "undefined" && wsClient) wsClient.disconnect();
  process.exit(0);
});

main().catch((err) => {
  console.error('❌ 启动失败:', err.message);
  process.exit(1);
});
