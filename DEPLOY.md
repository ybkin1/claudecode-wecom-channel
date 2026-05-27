# wecom-chat-agent 部署说明书

> 支持 Linux (systemd + PM2) 和 Windows (计划任务 / 直接运行) 两种环境。

## 目录

1. [部署前准备](#部署前准备)
2. [Linux 部署](#linux-部署)
3. [Windows 部署](#windows-部署)
4. [部署后验证](#部署后验证)
5. [常见问题](#常见问题)

---

## 部署前准备

### 需要你提供的信息

| 信息 | 说明 | 从哪里获取 |
|------|------|-----------|
| `WECOM_BOT_ID` | 企业微信 AI 机器人 ID | 企业微信管理后台 → 应用管理 → AI 机器人 |
| `WECOM_SECRET` | 企业微信 AI 机器人密钥 | 同上 |
| `BOT_NAME` | 机器人名称（群聊 @ 用） | 自定义，如 `<your-bot-name>` |
| `ALLOWED_USERS` | 白名单（可选） | 限制哪些用户能使用，留空则开放所有 |

### 服务器要求

| 环境 | Linux | Windows |
|------|-------|---------|
| 操作系统 | Ubuntu 18+ / CentOS 7+ | Windows 10+ / Server 2019+ |
| Node.js | ≥ 18.x | ≥ 18.x |
| Claude Code | 已安装并完成认证 | 已安装并完成认证 |
| 网络 | 可访问 `wss://openws.work.weixin.qq.com` | 同左 |
| 推荐内存 | ≥ 2GB 空闲 | ≥ 2GB 空闲 |

### 前置检查

```bash
# 确认 Node.js
node --version   # 应输出 v18.x 或更高

# 确认 Claude Code 可用
claude --version
claude           # 首次需完成 OAuth 登录（会弹出浏览器）
```

---

## Linux 部署

### 方式一：自动部署脚本（推荐）

```bash
# 下载脚本
wget https://raw.githubusercontent.com/<repo>/main/deploy.sh -O deploy.sh
# 或从本地复制 deploy.sh 到服务器

chmod +x deploy.sh
./deploy.sh
```

脚本会交互式询问你填写：
1. 企业微信 Bot ID
2. 企业微信 Secret
3. 机器人名称
4. 白名单（可选）
5. 部署路径（默认 `/opt/wecom-chat-agent`）
6. DeepSeek API 配置（可选）

执行完毕后自动完成：依赖安装 → 配置生成 → PM2 启动 → systemd 注册 → 开机自启。

### 方式二：手动部署

#### 1. 获取代码

```bash
git clone git@github.com:ybkin1/claudecode-wecom-channel.git /opt/wecom-chat-agent
cd /opt/wecom-chat-agent
```

#### 2. 安装依赖

```bash
cd /opt/wecom-chat-agent
npm install
```

#### 3. 配置

```bash
cp .env.example .env
vim .env  # 填入 WECOM_BOT_ID 和 WECOM_SECRET
```

```ini
WECOM_BOT_ID=your_bot_id_here
WECOM_SECRET=your_secret_here
BOT_NAME=<your-bot-name>
GROUP_CHAT_ENABLED=true
PRIVATE_CHAT_ENABLED=true
```

#### 4. 安装 PM2

```bash
npm install -g pm2
```

#### 5. 配置 PM2

```bash
# 从示例文件创建 PM2 配置（按需修改 API Key）
cp ecosystem.config.example.js ecosystem.config.js
vim ecosystem.config.js  # 修改 ANTHROPIC_API_KEY 为你的密钥

# 创建独立 PM2 实例
mkdir -p /opt/wecom-chat-agent/.pm2
mkdir -p /var/log/wecom-chat-agent
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 start /opt/wecom-chat-agent/ecosystem.config.js
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 save
```

#### 6. 创建 systemd 服务

```bash
cat > /etc/systemd/system/pm2-wecom.service << 'EOF'
[Unit]
Description=PM2 process manager for wecom-chat-agent
After=network.target

[Service]
Type=forking
User=root
LimitNOFILE=infinity
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PM2_HOME=/opt/wecom-chat-agent/.pm2
PIDFile=/opt/wecom-chat-agent/.pm2/pm2.pid
Restart=on-failure

ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pm2-wecom
systemctl start pm2-wecom
```

#### 7. 日常管理

```bash
# 状态
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 status

# 日志
tail -f /var/log/wecom-chat-agent/out.log

# 重启
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 restart wecom-chat-agent

# 停止
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 stop wecom-chat-agent
```

---

## Windows 部署

### 方式一：自动部署脚本

以**管理员身份**打开 PowerShell，执行：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
.\deploy.ps1
```

脚本会交互式询问：
1. 企业微信 Bot ID
2. 企业微信 Secret
3. 机器人名称
4. 部署路径（默认当前目录）

### 方式二：手动部署

#### 1. 获取代码

```powershell
git clone <repo-url>
cd wecom-chat-agent
```

#### 2. 安装依赖

```powershell
npm install
```

#### 3. 配置

```powershell
copy .env.example .env
notepad .env  # 填入 WECOM_BOT_ID 和 WECOM_SECRET
```

#### 4. 直接运行（前台）

```powershell
node main.js
```

看到 `✅ 认证成功，启动心跳...` 即表示成功。

#### 5. 设为开机自启（可选）

**方案 A: Windows 计划任务**

```powershell
# 创建计划任务（以管理员身份运行）
$action = New-ScheduledTaskAction -Execute "node" -Argument "main.js" -WorkingDirectory "C:\path\to\wecom-chat-agent"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "wecom-chat-agent" -Action $action -Trigger $trigger -Principal $principal
```

**方案 B: PM2 for Windows**

```powershell
npm install -g pm2
pm2 start main.js --name wecom-chat-agent
pm2 save
pm2 startup   # 按提示执行注册命令
```

#### 6. 日常管理（PM2）

```powershell
pm2 status
pm2 logs wecom-chat-agent
pm2 restart wecom-chat-agent
pm2 stop wecom-chat-agent
```

---

## 部署后验证

### 1. 检查服务状态

**Linux:**
```bash
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 status
# 应显示: status = online
```

**Windows (PM2):**
```powershell
pm2 status
```

### 2. 检查日志

确认以下关键日志出现：
```
✅ WebSocket 已连接
✅ 认证成功，启动心跳...
✅ WebSocket 已连接，等待消息...
🧹 沙箱: /tmp/wecom-sandbox (TTL=300s, maxSize=10MB)  ← FileBroker 已启动
[FileBroker] 沙箱目录: /tmp/wecom-sandbox
```

### 3. 验证沙箱

```bash
# 确认沙箱目录已创建
ls -la /tmp/wecom-sandbox/

# 确认 FileBroker 日志
grep FileBroker /var/log/wecom-chat-agent/out.log
```

### 4. 在群里测试

在企业微信群聊中 @机器人名称 发消息：
```
@cc-bot /help
```

应收到机器人的帮助信息回复，包含 `[FILE_OUTPUT]` 协议说明。

### 5. 文件功能测试

```
# 私聊发文件 → Claude 读取
发一张图片 → Claude 描述图片内容
发 .txt/.log → Claude 读取并总结
@cc-bot 生成一份 JSON 测试数据 → 收到 file 消息
```

### 4. 验证会话隔离

- 用户 A @机器人问一个问题
- 用户 B @机器人问另一个问题
- 确认两人得到的是各自相关的回复

### 5. 验证高可用

```bash
# 模拟进程崩溃（kill 后应自动重启）
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 status | grep pid

# 等待几秒后再次检查，pid 应变化，status 仍为 online
```

---

## 常见问题

### Q: 启动后报 "缺少企业微信配置"

**原因**：`.env` 文件未配置或 botId/secret 为空。

**解决**：检查 `.env` 文件中是否填写了 `WECOM_BOT_ID` 和 `WECOM_SECRET`。

### Q: 认证失败 / 请求超时

**原因**：botId 或 secret 不正确，或网络无法访问 WeCom。

**解决**：
1. 确认 botId 和 secret 与企业微信管理后台一致
2. 确认服务器能访问 `wss://openws.work.weixin.qq.com`
3. 重启服务重试

### Q: 群聊 @ 机器人无回复

**原因**：
- 机器人未加入该群聊
- @ 的名称与 `BOT_NAME` 不匹配
- 消息被去重机制过滤

**解决**：
1. 确认为企业微信 AI 机器人（不是普通群机器人）
2. 检查 `BOT_NAME` 配置是否与群聊中显示的名称一致
3. 查看日志确认是否收到了消息

### Q: "Cannot read properties of undefined (reading 'submit')"

**原因**：并发控制器未初始化，通常是代码部署不完整。

**解决**：确认 `concurrency-limiter.js` 文件存在，重新部署完整代码。

### Q: 回复很慢

**原因**：
- 多个用户同时提问，需要排队
- Claude Code 模型响应较慢
- 知识库文件较多，搜索耗时

**解决**：
1. 增大 `MAX_CONCURRENT` 减少排队
2. 使用更快的模型
3. 等待即可，上限 5 分钟

### Q: 如何更换模型

Claude Code 默认使用其内置模型。如需使用 DeepSeek 等第三方模型，在启动环境变量中设置：

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=your_api_key
ANTHROPIC_MODEL=deepseek-v4-pro
```

### Q: 收到文件后 Claude 说"无法读取"

**原因**：沙箱目录未正确挂载或权限不足。

**解决**：
1. 确认日志中 `🧹 沙箱: /tmp/wecom-sandbox` 已出现
2. 确认日志中有 `AES 解密完成` 字样（说明解密成功）
3. 检查 Claude 系统提示词是否包含 `--add-dir /tmp/wecom-sandbox`

### Q: 发送文件失败（markdown 附注显示"发送失败"）

**原因**：WebSocket 三阶段上传 (`aibot_upload_media_init/chunk/finish`) 可能因网络或 API 变更失败。

**解决**：
1. 查看日志中的具体错误信息
2. 确认 WeCom AI Bot 长连接版本支持 `aibot_upload_media_*` 命令（2026/03/13 新增）
3. 回退方案：系统会自动发送 markdown 附注告知用户

### Q: 沙箱目录文件堆积

**原因**：TTL 定时器未正常触发。

**解决**：
1. TTL 默认 5 分钟自动清理，查看日志 `[FileBroker] TTL 清理:`
2. 手动清理：`rm -f /tmp/wecom-sandbox/*`
3. 调整 TTL：设置环境变量 `FILE_TTL_MS=180000`（3 分钟）
