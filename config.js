/**
 * 配置管理 — 从 .env / config.json / 环境变量加载
 *
 * 优先级：环境变量 > config.json > .env > 默认值
 */

const fs = require('fs');
const path = require('path');

/**
 * 简易 .env 加载器（不依赖 dotenv 包）
 */
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const [key, ...rest] = line.split('=');
      const value = rest.join('=').trim();
      if (key && value && !process.env[key.trim()]) {
        process.env[key.trim()] = value.replace(/^["']|["']$/g, '');
      }
    });
  } catch (e) {
    // .env 文件可选，加载失败不影响
  }
}

// 先加载 .env
loadEnvFile();

const DEFAULTS = {
  // 企业微信
  botId: process.env.WECOM_BOT_ID || '',
  secret: process.env.WECOM_SECRET || '',
  wsUrl: 'wss://openws.work.weixin.qq.com',

  // Claude（通过 claude -p CLI，不需要 API Key）
  model: process.env.CLAUDE_MODEL || '',
  workingDir: process.env.WORKING_DIR || '',

  // 行为
  systemPrompt: process.env.SYSTEM_PROMPT || '',
  botName: process.env.BOT_NAME || 'cc-bot',
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL) || 30000,
  streamThrottleMs: parseInt(process.env.STREAM_THROTTLE_MS) || 500,
  sessionTtlMs: 2 * 60 * 60 * 1000,
  maxReconnectAttempts: 10,
  allowedUsers: process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(s => s.trim()).filter(Boolean) : [],
  groupChatEnabled: process.env.GROUP_CHAT_ENABLED !== 'false',
  privateChatEnabled: process.env.PRIVATE_CHAT_ENABLED !== 'false',

  // 并发控制
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT) || 3,
  queueSize: parseInt(process.env.QUEUE_SIZE) || 50,

  // FileBroker 沙箱配置
  sandboxDir: process.env.SANDBOX_DIR || '/tmp/wecom-sandbox',
  fileTtlMs: parseInt(process.env.FILE_TTL_MS) || 300000,
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760,
  allowedFileExtensions: process.env.ALLOWED_FILE_EXTENSIONS
    ? process.env.ALLOWED_FILE_EXTENSIONS.split(',').map(function(s) { return s.trim(); }).filter(Boolean)
    : null, // null 表示使用 FileBroker 内置默认值
};

function loadConfig() {
  // 尝试加载 config.json
  const configPath = path.join(__dirname, 'config.json');
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.warn('⚠️ config.json 解析失败:', e.message);
    }
  }

  // 合并（环境变量优先，其次 config.json）
  const config = { ...DEFAULTS, ...fileConfig };

  // 检查必填项
  if (!config.botId || !config.secret) {
    console.error(' 缺少企业微信配置：botId 或 secret');
    console.error('   请设置环境变量 WECOM_BOT_ID 和 WECOM_SECRET，');
    console.error('   或创建 .env 文件，或在 config.json 中填写。');
    console.error('   参考 .env.example');
    process.exit(1);
  }

  return config;
}

module.exports = { loadConfig };
