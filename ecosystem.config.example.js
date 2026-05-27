module.exports = {
  apps: [{
    name: 'wecom-chat-agent',
    namespace: 'wecom',
    script: 'main.js',
    cwd: '/opt/wecom-chat-agent',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    error_file: '/var/log/wecom-chat-agent/error.log',
    out_file: '/var/log/wecom-chat-agent/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      BOT_NAME: 'cc-bot',
      // 以下为模型配置，按需修改
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_API_KEY: 'YOUR_DEEPSEEK_API_KEY',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_INTERACTIVE: '0',
    },
  }],
};
