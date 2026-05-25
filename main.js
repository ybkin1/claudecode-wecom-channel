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
const { loadConfig } = require('./config.js');

// ─── 启动入口 ───

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
  console.log('');

  // 初始化核心组件
  const sessionManager = new SessionManager({ ttlMs: 2 * 60 * 60 * 1000 }); // 2h 过期
  const orchestrator = new ClaudeOrchestrator(config, sessionManager);
  const wsClient = new WeComWsClient(config);
  const dispatcher = new MessageDispatcher(wsClient, orchestrator, config);

  // 绑定回调
  wsClient.on('message', (msg) => dispatcher.handleMessage(msg));
  wsClient.on('event', (evt) => dispatcher.handleEvent(evt));
  wsClient.on('connect', () => console.log('✅ WebSocket 已连接，等待消息...'));
  wsClient.on('disconnect', (code) => console.log(`🔌 连接已关闭 (code=${code})`));

  // 启动连接
  console.log('📡 正在连接企业微信...');
  await wsClient.connect();
}

main().catch((err) => {
  console.error('❌ 启动失败:', err.message);
  process.exit(1);
});
