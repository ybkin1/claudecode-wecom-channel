# claudecode-wecom-channel

企业微信 ↔ Claude Code 双向聊天代理。通过 `claude -p --bare` 共享 Claude Code 认证，无需额外 API Key。

## 架构

```
企业微信用户 → WebSocket 长连接 → Node.js 代理 → claude -p --bare → Claude Code 模型
                                                    ↓
企业微信用户 ← markdown 流式回复 ← Node.js 代理 ← 文本输出
```

## 特性

- **零 API Key 配置** — 通过 `claude -p --bare` 共享 Claude Code OAuth 认证
- **流式回复** — 500ms 节流推送，体验流畅
- **会话管理** — 群聊/私聊隔离，2h TTL 自动过期
- **指令系统** — `/help`、`/reset`、`/clear`、`/status`
- **安全隔离** — 拒绝 Bash/Write/Edit 等危险工具，保护主 Claude Code 配置
- **消息去重** — 防止企业微信重复回调导致的重复回复

## 快速开始

### 前置条件

- Node.js >= 18
- 已安装并认证的 Claude Code (`claude --version`)
- 企业微信 AI 机器人（已创建并获取 botId + secret）

### 安装

```bash
# 1. 克隆仓库
git clone <repo-url>
cd claudecode-wecom-channel

# 2. 安装依赖
npm install

# 3. 配置
cp .env.example .env
# 编辑 .env，填入 botId 和 secret
```

### 运行

```bash
npm start
```

### 配置项

| 变量 | 必填 | 说明 |
|------|------|------|
| `WECOM_BOT_ID` | 是 | 企业微信 AI 机器人 ID |
| `WECOM_SECRET` | 是 | 企业微信 AI 机器人 Secret |
| `CLAUDE_MODEL` | 否 | 指定模型（如 sonnet） |
| `WORKING_DIR` | 否 | 知识库工作目录 |
| `BOT_NAME` | 否 | 机器人名称（群聊 @ 过滤用） |
| `ALLOWED_USERS` | 否 | 白名单用户 ID（逗号分隔） |

## 安全

通过以下三层防护隔离 WeCom 机器人能力：

1. **工具级拒绝** — `--disallowed-tools Bash Write Edit NotebookEdit Agent`
2. **权限模式** — `--permission-mode bypassPermissions`
3. **系统提示词** — 明确告知只读环境，拒绝配置修改请求

## 群聊使用

在群聊中 @机器人名称 即可对话，例如：

```
@智算秘书 介绍下你自己
```

## 私聊使用

直接发消息即可，机器人会自动回复。

## 许可证

MIT
