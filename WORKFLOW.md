# wecom-chat-agent 开发工作流

> 生产环境与开发环境隔离，禁止直接在生产环境修改代码。

## 环境拓扑

```
┌──────────────────────────────────────────────────────┐
│ GitHub: claudecode-wecom-channel                      │
│ ├── main     ← 生产代码（只允许从 dev 合入）           │
│ └── dev      ← 开发集成分支                           │
│     └── feature/xxx ← 功能分支                        │
└──────────────────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                              ▼
┌─────────────────────┐    ┌──────────────────────────┐
│ 生产环境             │    │ 开发环境                  │
│ /opt/wecom-chat-agent│    │ /opt/wecom-chat-agent-dev│
│ PM2: wecom-chat-agent│    │ PM2: wecom-chat-agent-dev│
│ 开机自启: ✅         │    │ 开机自启: ❌ (手动)       │
│ 自动重启: ✅         │    │ 自动重启: ❌ (手动)       │
│ 机器人名: <your-bot-name>│  │ 机器人名: <your-bot-name>_dev│
│ 状态: 生产服务        │    │ 状态: 按需启动            │
└─────────────────────┘    └──────────────────────────┘
```

## 日常开发流程

### 1. 从生产代码创建功能分支

```bash
git checkout main
git pull
git checkout -b feature/描述功能
```

### 2. 修改代码

在本地或开发服务器 `/opt/wecom-chat-agent-dev/` 修改。

**注意**：开发环境下 BOT_NAME 是 `<your-bot-name>_dev`，测试时 @ 这个名字。

### 3. 在开发环境测试

```bash
# 上传修改到开发环境
scp -r *.js root@server:/opt/wecom-chat-agent-dev/

# 启动开发环境
ssh root@server "PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 start /opt/wecom-chat-agent-dev/ecosystem.config.js"

# 在企业微信群里 @<your-bot-name>_dev 测试
# 注意：必须用开发机器人名，不能用生产名

# 停止开发环境
ssh root@server "PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 stop wecom-chat-agent-dev"
```

### 4. 测试通过后合入生产

```bash
# 提交代码
git add .
git commit -m "feat: 描述功能"
git push origin feature/描述功能

# 合入 dev → main
# (在 GitHub 上创建 PR，review 后合并)

# 部署到生产
scp -r *.js root@server:/opt/wecom-chat-agent/
ssh root@server "PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 restart wecom-chat-agent"
```

## 环境对照表

| 项目 | 生产 | 开发 |
|------|------|------|
| **目录** | `/opt/wecom-chat-agent` | `/opt/wecom-chat-agent-dev` |
| **PM2_HOME** | `/opt/wecom-chat-agent/.pm2` | `/opt/wecom-chat-agent-dev/.pm2` |
| **进程名** | `wecom-chat-agent` | `wecom-chat-agent-dev` |
| **namespace** | `wecom` | `wecom-dev` |
| **BOT_NAME** | `<your-bot-name>` | `<your-bot-name>_dev` |
| **日志** | `/var/log/wecom-chat-agent/` | `/var/log/wecom-chat-agent-dev/` |
| **开机自启** | ✅ systemd | ❌ |
| **崩溃重启** | ✅ | ❌ |
| **git 分支** | `main` | `dev` / `feature/*` |

## 管理命令速查

### 生产环境

```bash
# 状态 / 日志 / 重启
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 status
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 logs
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 restart wecom-chat-agent
tail -f /var/log/wecom-chat-agent/out.log
```

### 开发环境

```bash
# 启动
PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 start /opt/wecom-chat-agent-dev/ecosystem.config.js

# 状态 / 日志 / 停止
PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 status
PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 logs
PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 stop wecom-chat-agent-dev
tail -f /var/log/wecom-chat-agent-dev/out.log
```

## 注意事项

1. **不要在生产环境直接改代码** — 所有修改先在 dev 测试
2. **测试时 @ 开发机器人名** — 生产是 `@<your-bot-name>`，开发是 `@<your-bot-name>_dev`
3. **两个机器人共用同一个 WeCom Bot**（同一个 botId/secret），不能同时启动 — 因为 WebSocket 只能有一个连接
4. **开发完成记得停止 dev** — 否则会占用 WebSocket 连接，导致生产收不到消息
5. **部署到生产后验证** — 在群里 @<your-bot-name> 发 `/status` 确认正常
