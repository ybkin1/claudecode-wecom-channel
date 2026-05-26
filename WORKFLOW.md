# wecom-chat-agent 开发工作流

> 生产环境与开发环境隔离，禁止直接在生产环境修改代码。

## 环境拓扑

```
┌──────────────────────────────────────────────────────┐
│ GitHub: ybkin1/claudecode-wecom-channel               │
│ ├── main         ← 生产代码（只允许从 feature 合入）    │
│ └── feature/*    ← 功能分支（开发 + 测试）             │
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
│ 机器人名: cc-bot     │    │ 机器人名: cc-bot         │
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

### 2. 修改代码 + 本地测试

```bash
# 运行单元测试
node test-file-broker.js
```

### 3. 部署到开发环境

```bash
# 推送分支
git add .
git commit -m "feat: 描述功能"
git push origin feature/描述功能

# 部署到开发服务器
ssh claude_aly "cd /opt/wecom-chat-agent-dev && git pull && \
  PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 delete wecom-chat-agent-dev && \
  PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 start ecosystem.config.js"
```

### 4. 在开发环境测试

> ⚠️ **重要**：生产和开发使用同一个 WeCom Bot，不能同时启动。测试时先停止生产，启动开发；测试完停止开发，恢复生产。

```bash
# 停止生产，启动开发
ssh claude_aly "PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 stop wecom-chat-agent && \
  PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 start /opt/wecom-chat-agent-dev/ecosystem.config.js"

# 在企业微信里 @cc-bot 测试
# 测试项：
#   - 发文本消息 → 正常回复
#   - 发图片 → Claude 能描述图片内容
#   - 发文件 → Claude 能读取文件内容
#   - 让 Claude 生成 JSON → 收到文件消息

# 测试完成，恢复生产
ssh claude_aly "PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 stop wecom-chat-agent-dev && \
  PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 start /opt/wecom-chat-agent/ecosystem.config.js"
```

### 5. 测试通过后合入生产

```bash
# 在 GitHub 上创建 PR: feature/描述功能 → main
# Review + Merge 后:
ssh claude_aly "cd /opt/wecom-chat-agent && git pull && \
  PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 restart wecom-chat-agent"
```

## 文件功能测试清单

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 1 | 接收图片 | 私聊发一张 JPG/PNG | Claude 用 Read 读取并描述 |
| 2 | 接收文件 | 私聊发 .txt/.log | Claude 用 Read 读取并总结 |
| 3 | 文字+文件同时到达 | 同时发文字和文件 | 两次消息合并为一个上下文 |
| 4 | 生成 JSON | @bot "生成一份测试 JSON" | 收到 file 消息 |
| 5 | 生成 CSV | @bot "生成 CSV 数据" | 收到 file 消息 |
| 6 | 非法扩展名 | @bot "生成 .exe" | FILE_OUTPUT 被过滤 |
| 7 | TTL 清理 | 等 5 分钟 | `ls /tmp/wecom-sandbox/` 为空 |
| 8 | 路径安全 | — | 自动拦截（代码内置） |

## 环境对照表

| 项目 | 生产 | 开发 |
|------|------|------|
| **目录** | `/opt/wecom-chat-agent` | `/opt/wecom-chat-agent-dev` |
| **PM2_HOME** | `/opt/wecom-chat-agent/.pm2` | `/opt/wecom-chat-agent-dev/.pm2` |
| **进程名** | `wecom-chat-agent` | `wecom-chat-agent-dev` |
| **namespace** | `wecom` | `wecom-dev` |
| **BOT_NAME** | `cc-bot` | `cc-bot` |
| **沙箱目录** | `/tmp/wecom-sandbox/` | `/tmp/wecom-sandbox/` |
| **日志** | `/var/log/wecom-chat-agent/` | `/var/log/wecom-chat-agent-dev/` |
| **开机自启** | ✅ systemd | ❌ |
| **崩溃重启** | ✅ | ❌ |
| **git 分支** | `main` | `feature/*` |

## 管理命令速查

### 生产环境

```bash
# 状态 / 日志 / 重启
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 status
tail -f /var/log/wecom-chat-agent/out.log
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 restart wecom-chat-agent
```

### 开发环境

```bash
# 启动
PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 start /opt/wecom-chat-agent-dev/ecosystem.config.js

# 状态 / 日志 / 停止
PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 status
tail -f /var/log/wecom-chat-agent-dev/out.log
PM2_HOME=/opt/wecom-chat-agent-dev/.pm2 pm2 stop wecom-chat-agent-dev
```

### 沙箱管理

```bash
# 查看沙箱文件
ls -la /tmp/wecom-sandbox/

# 手动清理
rm -f /tmp/wecom-sandbox/*

# 查看 FileBroker 日志
grep FileBroker /var/log/wecom-chat-agent/out.log | tail -10
```

## 注意事项

1. **不要在生产环境直接改代码** — 所有修改先在 dev 测试
2. **生产和开发共用一个 WeCom Bot** — 不能同时启动，需手动切换
3. **开发完成记得恢复生产** — 否则生产服务中断
4. **文件有效期 5 分钟** — 沙箱文件 TTL 默认 300s，超时自动清理
5. **WeCom 文件有 AES 加密** — FileBroker 自动处理 `aeskey` 解密
6. **生成文件用 [FILE_OUTPUT] 协议** — 详见 README.md 协议说明
