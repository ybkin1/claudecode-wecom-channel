# ============================================================
# wecom-chat-agent — Windows 自动部署脚本
# ============================================================
# 用法: 以管理员身份运行 PowerShell，执行 .\deploy.ps1
# 功能: 交互式配置 → 安装依赖 → (可选)PM2 部署
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  wecom-chat-agent Windows 自动部署" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ─── 1. 环境检查 ───

Write-Host "[1/5] 检查运行环境..." -ForegroundColor Yellow

try {
    $nodeVersion = node -v 2>&1
    Write-Host "   ✅ Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Node.js 未安装，请先安装 Node.js >= 18" -ForegroundColor Red
    Write-Host "   下载: https://nodejs.org/" -ForegroundColor Red
    exit 1
}

try {
    claude --version 2>&1 | Out-Null
    Write-Host "   ✅ Claude Code 已安装" -ForegroundColor Green
} catch {
    Write-Host "   ⚠️  claude 命令未找到" -ForegroundColor Yellow
    Write-Host "   请确保已安装: npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
    Write-Host "   并完成认证: claude (首次运行会弹出浏览器)" -ForegroundColor Yellow
    $continue = Read-Host "   是否继续？(y/n)"
    if ($continue -ne "y") { exit 1 }
}

Write-Host ""

# ─── 2. 收集配置 ───

Write-Host "[2/5] 配置企业微信机器人..." -ForegroundColor Yellow

do {
    $WECOM_BOT_ID = Read-Host "   企业微信 Bot ID"
    if ([string]::IsNullOrWhiteSpace($WECOM_BOT_ID)) {
        Write-Host "   ⚠️  Bot ID 不能为空" -ForegroundColor Yellow
    }
} while ([string]::IsNullOrWhiteSpace($WECOM_BOT_ID))

do {
    $WECOM_SECRET = Read-Host "   企业微信 Secret"
    if ([string]::IsNullOrWhiteSpace($WECOM_SECRET)) {
        Write-Host "   ⚠️  Secret 不能为空" -ForegroundColor Yellow
    }
} while ([string]::IsNullOrWhiteSpace($WECOM_SECRET))

$BOT_NAME = Read-Host "   机器人名称 [yb_claudecode]"
if ([string]::IsNullOrWhiteSpace($BOT_NAME)) { $BOT_NAME = "yb_claudecode" }

$ALLOWED_USERS = Read-Host "   白名单用户ID（逗号分隔，留空则允许所有用户）"

$DEEPSEEK_KEY = Read-Host "   DeepSeek API Key（可选，留空则使用默认 Claude 模型）"

$DEPLOY_DIR = Read-Host "   部署目录 [当前目录]"
if ([string]::IsNullOrWhiteSpace($DEPLOY_DIR)) { $DEPLOY_DIR = (Get-Location).Path }

Write-Host ""
Write-Host "   📋 配置确认:" -ForegroundColor Cyan
Write-Host "      Bot ID      : " -NoNewline; Write-Host $WECOM_BOT_ID.Substring(0, [Math]::Min(12, $WECOM_BOT_ID.Length)) + "..." -ForegroundColor White
Write-Host "      机器人名称   : $BOT_NAME" -ForegroundColor White
Write-Host "      白名单      : $(if ($ALLOWED_USERS) { $ALLOWED_USERS } else { '所有用户' })" -ForegroundColor White
Write-Host "      部署目录    : $DEPLOY_DIR" -ForegroundColor White
Write-Host "      模型        : $(if ($DEEPSEEK_KEY) { 'DeepSeek' } else { '默认 Claude' })" -ForegroundColor White
Write-Host ""

$confirm = Read-Host "   确认以上配置？(y/n)"
if ($confirm -ne "y") {
    Write-Host "已取消。"
    exit 0
}

# ─── 3. 准备部署目录 ───

Write-Host ""
Write-Host "[3/5] 准备部署目录..." -ForegroundColor Yellow

# 获取脚本所在目录
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 如果脚本在项目目录中，复制文件
if (Test-Path "$scriptDir\main.js") {
    New-Item -ItemType Directory -Force -Path $DEPLOY_DIR | Out-Null
    Copy-Item -Path "$scriptDir\*.js", "$scriptDir\package.json", "$scriptDir\ecosystem.config.js" -Destination $DEPLOY_DIR -Force
} else {
    Write-Host "   ⚠️  脚本不在项目根目录，请确保 $DEPLOY_DIR 中已有项目文件" -ForegroundColor Yellow
}

# 创建 .env
$envContent = @"
# 企业微信 AI 机器人配置
WECOM_BOT_ID=$WECOM_BOT_ID
WECOM_SECRET=$WECOM_SECRET

# 行为配置
BOT_NAME=$BOT_NAME
GROUP_CHAT_ENABLED=true
PRIVATE_CHAT_ENABLED=true
STREAM_THROTTLE_MS=500
HEARTBEAT_INTERVAL=30000
"@

if ($ALLOWED_USERS) {
    $envContent += "`nALLOWED_USERS=$ALLOWED_USERS"
}

$envContent | Out-File -FilePath "$DEPLOY_DIR\.env" -Encoding utf8
Write-Host "   ✅ 配置文件已生成: $DEPLOY_DIR\.env" -ForegroundColor Green

# ─── 4. 安装依赖 ───

Write-Host ""
Write-Host "[4/5] 安装 Node.js 依赖..." -ForegroundColor Yellow

Set-Location $DEPLOY_DIR
npm install --production
Write-Host "   ✅ 依赖安装完成" -ForegroundColor Green

# ─── 5. 启动方式选择 ───

Write-Host ""
Write-Host "[5/5] 选择启动方式..." -ForegroundColor Yellow
Write-Host ""
Write-Host "   1) 直接运行（前台，关闭窗口即停止）" -ForegroundColor White
Write-Host "   2) PM2 管理（后台运行，推荐）" -ForegroundColor White
Write-Host "   3) 仅生成配置，稍后手动启动" -ForegroundColor White
Write-Host ""

$choice = Read-Host "   请选择 (1/2/3)"

switch ($choice) {
    "1" {
        Write-Host ""
        Write-Host "   🚀 正在启动 (前台模式)..." -ForegroundColor Cyan
        Write-Host "   按 Ctrl+C 停止" -ForegroundColor Yellow
        Write-Host ""
        node "$DEPLOY_DIR\main.js"
    }
    "2" {
        Write-Host ""
        Write-Host "   正在安装 PM2..." -ForegroundColor Cyan

        # 检查 PM2
        try { pm2 --version 2>&1 | Out-Null } catch {
            npm install -g pm2
        }

        # 配置 DeepSeek（如果提供了 key）
        if ($DEEPSEEK_KEY) {
            Write-Host "   配置 DeepSeek 模型..." -ForegroundColor Cyan
            $env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
            $env:ANTHROPIC_AUTH_TOKEN = $DEEPSEEK_KEY
            $env:ANTHROPIC_MODEL = "deepseek-v4-pro"
            $env:CLAUDE_CODE_SIMPLE = "1"
            $env:CLAUDE_CODE_INTERACTIVE = "0"

            # 写入 ecosystem.config.js
            if (Test-Path "$DEPLOY_DIR\ecosystem.config.js") {
                $ecosystemContent = Get-Content "$DEPLOY_DIR\ecosystem.config.js" -Raw
                $ecosystemContent = $ecosystemContent -replace "ANTHROPIC_BASE_URL: '.*'", "ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'"
                $ecosystemContent = $ecosystemContent -replace "ANTHROPIC_AUTH_TOKEN: '.*'", "ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_KEY'"
                $ecosystemContent | Set-Content "$DEPLOY_DIR\ecosystem.config.js"
            }
        }

        Set-Location $DEPLOY_DIR

        # 检查是否有 ecosystem.config.js
        if (Test-Path "$DEPLOY_DIR\ecosystem.config.js") {
            pm2 start "$DEPLOY_DIR\ecosystem.config.js"
        } else {
            pm2 start "$DEPLOY_DIR\main.js" --name wecom-chat-agent
        }

        pm2 save

        Write-Host ""
        Write-Host "   ✅ PM2 启动完成" -ForegroundColor Green
        Write-Host ""
        Write-Host "   设置开机自启（可选）：" -ForegroundColor Cyan
        Write-Host "   pm2 startup" -ForegroundColor White
        Write-Host "   （按提示复制并执行生成的命令）" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "   管理命令:" -ForegroundColor Cyan
        Write-Host "   pm2 status" -ForegroundColor White
        Write-Host "   pm2 logs wecom-chat-agent" -ForegroundColor White
        Write-Host "   pm2 restart wecom-chat-agent" -ForegroundColor White
    }
    "3" {
        Write-Host ""
        Write-Host "   ✅ 配置文件已就绪，手动启动：" -ForegroundColor Green
        Write-Host "   node $DEPLOY_DIR\main.js" -ForegroundColor White
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ✅ 部署完成！" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "   请在群里 @$BOT_NAME 发送 /help 测试" -ForegroundColor White
Write-Host ""
