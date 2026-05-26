#!/bin/bash
# ============================================================
# wecom-chat-agent — Linux 自动部署脚本
# ============================================================
# 用法: chmod +x deploy.sh && ./deploy.sh
# 功能: 交互式配置 → 安装依赖 → PM2 部署 → 开机自启
# ============================================================

set -e

echo "========================================"
echo "  wecom-chat-agent Linux 自动部署"
echo "========================================"
echo ""

# ─── 1. 环境检查 ───

echo "[1/6] 检查运行环境..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装，请先安装 Node.js >= 18"
    echo "   推荐: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 版本过低 ($(node -v))，需要 >= 18"
    exit 1
fi
echo "   ✅ Node.js $(node -v)"

if ! command -v claude &> /dev/null; then
    echo "⚠️  claude 命令未找到，请确保已安装 Claude Code 并完成认证"
    echo "   安装: npm install -g @anthropic-ai/claude-code"
    echo "   认证: claude (首次运行会弹出浏览器)"
    echo ""
    read -p "   是否继续？(y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
else
    echo "   ✅ Claude Code 已安装"
fi

echo ""

# ─── 2. 收集配置 ───

echo "[2/6] 配置企业微信机器人..."

read -p "   企业微信 Bot ID: " WECOM_BOT_ID
while [ -z "$WECOM_BOT_ID" ]; do
    echo "   ⚠️  Bot ID 不能为空"
    read -p "   企业微信 Bot ID: " WECOM_BOT_ID
done

read -p "   企业微信 Secret: " WECOM_SECRET
while [ -z "$WECOM_SECRET" ]; do
    echo "   ⚠️  Secret 不能为空"
    read -p "   企业微信 Secret: " WECOM_SECRET
done

read -p "   机器人名称 [yb_claudecode]: " BOT_NAME
BOT_NAME=${BOT_NAME:-yb_claudecode}

read -p "   白名单用户ID（逗号分隔，留空则允许所有用户）: " ALLOWED_USERS

read -p "   DeepSeek API Key（可选，留空则使用默认 Claude 模型）: " DEEPSEEK_KEY

read -p "   部署目录 [/opt/wecom-chat-agent]: " DEPLOY_DIR
DEPLOY_DIR=${DEPLOY_DIR:-/opt/wecom-chat-agent}

echo ""
echo "   📋 配置确认:"
echo "      Bot ID      : ${WECOM_BOT_ID:0:12}..."
echo "      机器人名称   : $BOT_NAME"
echo "      白名单      : ${ALLOWED_USERS:-所有用户}"
echo "      部署目录    : $DEPLOY_DIR"
echo "      模型        : ${DEEPSEEK_KEY:+DeepSeek}${DEEPSEEK_KEY:-默认 Claude}"
echo ""

read -p "   确认以上配置？(y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消。"
    exit 0
fi

# ─── 3. 创建目录和文件 ───

echo ""
echo "[3/6] 准备部署目录..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$SCRIPT_DIR/main.js" ]; then
    echo "   ⚠️  当前目录不是项目根目录，将创建新目录并复制文件..."
    echo "   请确保 deploy.sh 位于 wecom-chat-agent 项目根目录"
    echo "   或手动将项目文件放到 $DEPLOY_DIR"
fi

mkdir -p "$DEPLOY_DIR"
mkdir -p /var/log/wecom-chat-agent

# 如果脚本在项目目录中，复制所有文件
if [ -f "$SCRIPT_DIR/main.js" ]; then
    cp -r "$SCRIPT_DIR"/*.js "$SCRIPT_DIR"/package.json "$SCRIPT_DIR"/.env.example "$SCRIPT_DIR"/ecosystem.config.js "$DEPLOY_DIR/" 2>/dev/null || true
fi

# 创建 .env
cat > "$DEPLOY_DIR/.env" << EOF
# 企业微信 AI 机器人配置
WECOM_BOT_ID=$WECOM_BOT_ID
WECOM_SECRET=$WECOM_SECRET

# 行为配置
BOT_NAME=$BOT_NAME
GROUP_CHAT_ENABLED=true
PRIVATE_CHAT_ENABLED=true
STREAM_THROTTLE_MS=500
HEARTBEAT_INTERVAL=30000
EOF

if [ -n "$ALLOWED_USERS" ]; then
    echo "ALLOWED_USERS=$ALLOWED_USERS" >> "$DEPLOY_DIR/.env"
fi

echo "   ✅ 配置文件已生成: $DEPLOY_DIR/.env"

# ─── 4. 安装依赖 ───

echo ""
echo "[4/6] 安装 Node.js 依赖..."

cd "$DEPLOY_DIR"
npm install --production
echo "   ✅ 依赖安装完成"

# ─── 5. PM2 部署 ───

echo ""
echo "[5/6] 配置 PM2..."

if ! command -v pm2 &> /dev/null; then
    echo "   正在安装 PM2..."
    npm install -g pm2
fi

# 创建独立 PM2 数据目录
mkdir -p "$DEPLOY_DIR/.pm2"

# 更新 ecosystem.config.js 中的路径
if [ -f "$DEPLOY_DIR/ecosystem.config.js" ]; then
    # 使用 sed 更新 cwd 路径
    sed -i "s|cwd: '.*'|cwd: '$DEPLOY_DIR'|" "$DEPLOY_DIR/ecosystem.config.js"
fi

# 配置 DeepSeek（如果提供了 key）
if [ -n "$DEEPSEEK_KEY" ]; then
    # 在 ecosystem.config.js 中添加环境变量
    if grep -q "ANTHROPIC_BASE_URL" "$DEPLOY_DIR/ecosystem.config.js" 2>/dev/null; then
        sed -i "s|ANTHROPIC_BASE_URL: '.*'|ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'|" "$DEPLOY_DIR/ecosystem.config.js"
        sed -i "s|ANTHROPIC_AUTH_TOKEN: '.*'|ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_KEY'|" "$DEPLOY_DIR/ecosystem.config.js"
    fi
fi

# 启动
PM2_HOME="$DEPLOY_DIR/.pm2" pm2 start "$DEPLOY_DIR/ecosystem.config.js"
PM2_HOME="$DEPLOY_DIR/.pm2" pm2 save

echo "   ✅ PM2 启动完成"

# ─── 6. 开机自启 ───

echo ""
echo "[6/6] 配置开机自启..."

SYSTEMD_FILE="/etc/systemd/system/pm2-wecom.service"

if [ ! -f "$SYSTEMD_FILE" ]; then
    cat > "$SYSTEMD_FILE" << SYSTEMD_EOF
[Unit]
Description=PM2 process manager for wecom-chat-agent
After=network.target

[Service]
Type=forking
User=root
LimitNOFILE=infinity
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PM2_HOME=$DEPLOY_DIR/.pm2
PIDFile=$DEPLOY_DIR/.pm2/pm2.pid
Restart=on-failure

ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

    systemctl daemon-reload
    systemctl enable pm2-wecom
    systemctl start pm2-wecom 2>/dev/null || true
    echo "   ✅ systemd 服务已创建并启用"
else
    echo "   ⚠️  $SYSTEMD_FILE 已存在，跳过"
fi

# ─── 完成 ───

echo ""
echo "========================================"
echo "  ✅ 部署完成！"
echo "========================================"
echo ""
echo "   部署目录: $DEPLOY_DIR"
echo "   配置文件: $DEPLOY_DIR/.env"
echo "   日志文件: /var/log/wecom-chat-agent/out.log"
echo ""
echo "   管理命令:"
echo "     查看状态: PM2_HOME=$DEPLOY_DIR/.pm2 pm2 status"
echo "     查看日志: tail -f /var/log/wecom-chat-agent/out.log"
echo "     重启服务: PM2_HOME=$DEPLOY_DIR/.pm2 pm2 restart wecom-chat-agent"
echo "     停止服务: PM2_HOME=$DEPLOY_DIR/.pm2 pm2 stop wecom-chat-agent"
echo ""
echo "   请在群里 @$BOT_NAME 发送 /help 测试"
echo ""
