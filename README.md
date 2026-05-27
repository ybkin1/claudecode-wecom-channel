# wecom-chat-agent

企业微信 ↔ Claude Code 双向聊天代理。通过 `claude -p --bare` 共享 Claude Code 认证，**无需额外 API Key**。

## 机器人能力边界

### 可以做的事

| 能力 | 说明 | 示例 |
|------|------|------|
| 📖 **读取知识库** | Read / Grep / Glob 搜索和读取知识库文件 | "帮我查一下部署文档"、"搜索包含 TDW 的代码" |
| 🧠 **理解上下文** | 记住当前会话中的对话历史，支持多轮对话 | "再详细解释一下刚才那个概念" |
| 📝 **分析回答** | 代码审查、文档解读、技术分析、方案建议 | "这段代码有什么问题？" "帮我分析这个架构" |
| 📅 **解释信息** | 知识问答、概念解释、日期时间等通用问答 | "什么是 Kubernetes？" "现在几点？" |
| 🔍 **文件搜索** | 在整个知识库中搜索文件、关键词 | "找一下所有关于消息队列的笔记" |
| 🗂️ **目录浏览** | 查看知识库目录结构 | "列出 projects 目录下的文件" |

### 不能做的事

| 限制 | 原因 | 说明 |
|------|------|------|
| ❌ **修改/写入文件** | 安全隔离（`--allowedTools`）| 无法创建、编辑、删除知识库中的任何文件 |
| ❌ **执行命令** | 安全隔离 | 无法运行 shell 命令、脚本、编译代码 |
| ✅ **接收文件/图片** | FileBroker AES 解密 + 沙箱 | 图片和文件自动下载、AES-256-CBC 解密，Claude Read 工具可读 |
| ✅ **发送文件/图片** | [FILE_OUTPUT] 协议 + WS 上传 | 支持 Claude 生成 JSON/CSV 等文件并发送给用户 |
| ❌ **修改配置** | 安全隔离 + 系统提示词 | 无法修改 Claude Code 设置、系统配置 |
| ❌ **调用外部 API** | 无 Agent/Bash 权限 | 无法访问互联网、调用其他服务 |

### 工具权限矩阵

```
Claude 子进程:
✅ Read      — 读取文件（知识库 + 沙箱 /tmp/wecom-sandbox）
✅ Grep      — 内容搜索（正则匹配、关键词检索）
✅ Glob      — 文件名匹配（按模式搜索文件）
✅ WebSearch — 网络搜索（需要时可查最新信息）
✅ WebFetch  — 网页内容获取（读取在线文档）
❌ Write     — 写入文件（由 FileBroker 代理）
❌ Edit      — 编辑文件
❌ Bash      — 执行命令
❌ Agent     — 启动子 Agent

FileBroker (Node.js 层):
✅ writeContent  — 沙箱内受限写入（UUID 命名 + 扩展名白名单 + TTL 自动清理）
✅ downloadAndStore — HTTP 下载 + AES-256-CBC 解密 + 存入沙箱
❌ 路径遍历攻击   — resolve+realpath+startsWith 拦截
❌ 符号链接攻击   — fs.realpathSync 解析
```

## 架构

```
┌──────────────┐     WebSocket      ┌──────────────────────────────────────┐     spawn CLI     ┌──────────────┐
│  企业微信用户  │ ◄─────────────────► │        Node.js 代理                  │ ◄───────────────► │  Claude Code │
│              │   msg_callback     │                                    │   claude -p      │  (只读)       │
│  群聊 / 私聊  │   send_msg (推送)   │  ┌──────────┐  ┌────────────────┐  │                  │  Read/Grep    │
│  + 文件/图片  │   upload_media     │  │ 消息分发器 │  │  FileBroker    │  │  --add-dir       │  Glob/Web*    │
└──────────────┘                    │  │ 会话管理  │  │  沙箱安全读写   │  │  sandbox         │              │
                                    │  │ 并发控制  │  │  AES解密/上传  │  │                  └──────────────┘
                                    │  └──────────┘  └────────┬───────┘  │
                                    │                         │          │
                                    │              /tmp/wecom-sandbox/     │
                                    │              (UUID命名+TTL清理)      │
                                    └──────────────────────────────────────┘
```

### FileBroker 安全沙箱

Claude 子进程**不能写入文件**，但需要收发文件时，由 FileBroker 代理所有写操作：

| 安全层 | 机制 | 说明 |
|--------|------|------|
| **路径隔离** | `/tmp/wecom-sandbox/` | 所有文件操作限定在沙箱目录内 |
| **路径遍历防御** | resolve + realpath + startsWith | 拒绝 `..`、符号链接、跨目录访问 |
| **文件名不可控** | `crypto.randomUUID()` | 用户无法猜测或覆盖文件名 |
| **扩展名白名单** | `.md/.txt/.json/.csv` 等 | `writeContent` 拒绝 `.exe/.sh/.php` 等危险扩展名 |
| **TTL 自动清理** | 默认 5 分钟 | 超时自动 `fs.unlink`，防止磁盘堆积 |
| **文件大小限制** | 默认 10MB | 拒绝超大文件，防止内存耗尽 |
| **AES 解密** | AES-256-CBC | WeCom 文件回调自动解密（`aeskey` 字段） |
| **符号链接防御** | `fs.realpathSync` | 所有路径解析后二次验证 |

### FILE_OUTPUT 协议

Claude 生成的回复中可以嵌入文件，系统会自动提取并发送给用户：

```
[FILE_OUTPUT:report.json]
{"total": 100, "items": ["a", "b", "c"]}
[/FILE_OUTPUT]
```

协议规则：
- 文件名必须包含允许的扩展名（`.json/.csv/.txt/.md` 等）
- 每个 `[FILE_OUTPUT]...[/FILE_OUTPUT]` 块生成一个独立文件
- 图片类文件（`.png/.jpg`）作为 image 消息发送
- 非图片文件（`.json/.csv/.md`）作为 file 消息发送
- 块外文本正常作为 markdown 回复

### 消息处理全链路

```
用户发送消息（WeCom）
  │
  ▼
[WebSocket 接收] aibot_msg_callback
  │
  ├─→ msgId 去重检查（30s 窗口）→ 重复则跳过
  ├─→ 白名单检查 → 非白名单用户忽略
  ├─→ 消息类型路由:
  │   ├─→ text  → 常规文本处理
  │   ├─→ image → HTTP 下载 + AES 解密 → 存入沙箱 → 缓存文件上下文
  │   └─→ file  → HTTP 下载 + AES 解密 → 存入沙箱 → 缓存文件上下文
  ├─→ 群聊 @ 过滤     → 未 @ 机器人则忽略
  ├─→ 内容哈希去重（10s 窗口）→ 重复则跳过
  │
  ▼
[消息分发器] _dispatchText
  │
  ├─→ 并发锁检查 → 同会话正在处理则跳过
  ├─→ 指令检查 → /help /reset /clear /status 立即回复
  │
  ▼
[并发队列] _concurrencyLimiter.submit()
  │
  ├─→ 队列满 → 拒绝并回复"请求较多，请稍后再试"
  ├─→ 有空位 → 立即执行
  ├─→ 无空位 → 排队等待
  │
  ▼
[Claude 调用] claude -p --bare
  │
  ├─→ 构建 prompt（含对话历史 + 用户身份）
  ├─→ spawn 子进程，stdout 流式读取
  ├─→ 500ms 节流推送到 WeCom
  ├─→ 5 分钟超时
  │
  ▼
[保存会话] sessionManager.addMessage()
  │
  ▼
用户收到回复
```

### 回复等待时间

机器人收到消息后，回复所需的时间取决于任务复杂度和排队情况：

#### 无排队时（直接处理）

| 任务类型 | 典型耗时 | 示例 |
|---------|---------|------|
| 简单问答 | 10-30 秒 | "现在几点？" "/help" "/status" |
| 文件搜索/读取 | 30 秒-2 分钟 | "帮我查一下部署文档" |
| 跨文件分析 | 1-3 分钟 | "比较 A 和 B 两个方案的差异" |
| 深度分析 | 3-5 分钟 | "完整审查这个模块的代码安全性" |
| 超时上限 | **5 分钟** | 超过后返回超时错误提示 |

#### 有排队时

排队等待时间 = 前面排队人数 × 当前处理中任务的平均时长。

```
假设 3 个槽位都在忙，你排在第 4 位：
  - 最快：前面都是简单问答 → 等待约 10-40 秒
  - 正常：前面有复杂任务 → 等待约 1-3 分钟
  - 最差：队列满（50 人）→ 直接拒绝，提示"稍后再试"
```

#### 关键时间参数

| 参数 | 值 | 作用 |
|------|-----|------|
| Claude 响应超时 | 5 分钟 | 单个请求最大处理时间 |
| 流式推送间隔 | 500ms | 回复开始出现后，每 500ms 更新一次内容 |
| 首字延迟 | 5-15 秒 | 从发消息到看到第一个字的时间 |
| 并发槽位 | 3 个 | 同时最多处理 3 个请求 |
| 队列长度 | 50 个 | 排队上限，满了直接拒绝 |
| 同一会话并发锁 | 立即 | 同一人发多条，后面的直接跳过 |

## 上下文与记忆机制

### 会话隔离策略

每个用户在**不同场景**下拥有**独立的会话上下文**，互不干扰：

```
群聊 "技术讨论群"
├── 用户 A 的会话: group:<chatid>:<userA_id>
│   └── 消息历史: [A: "什么是 Docker?" → 助手: "Docker 是..."]
│                  [A: "那 Kubernetes 呢？" → 助手理解"那"指容器编排...]
│
├── 用户 B 的会话: group:<chatid>:<userB_id>
│   └── 消息历史: [B: "帮我查部署文档" → 助手: "找到了以下文档..."]
│                  [B: "详细说第二篇" → 助手知道 B 在问部署...]
│
└── 用户 C 的会话: group:<chatid>:<userC_id>
    └── 消息历史: [C: "今天天气怎样" → 助手: "抱歉无法查天气..."]

私聊
├── 用户 A 的私聊: private:<userA_id>
│   └── 与群聊中的 A 完全独立，不共享上下文
│
└── 用户 B 的私聊: private:<userB_id>
    └── 与群聊中的 B 完全独立，不共享上下文
```

### 关键行为

| 行为 | 规则 |
|------|------|
| **群聊中 @** | 每人独立会话，互不可见对方的历史 |
| **同一人多次 @** | 共享同一会话（理解为同一人在连续对话） |
| **私聊** | 每个用户独立会话，与群聊完全隔离 |
| **会话过期** | 2 小时无活动自动清除 |
| **上下文长度** | 历史上限 50 条，超过保留最新 40 条 |
| **重置指令** | `/reset` 或 `/clear` 立即清除当前用户会话 |
| **连续对话** | 支持代词指代（"上面那个"、"再详细解释"）、多轮追问 |

## 多用户排队与并发控制

### 为什么需要排队

机器人背后是 `claude -p --bare` 子进程，每次调用会启动一个完整的 Claude Code 实例，消耗较大。如果 5 个人同时 @ 机器人，不控制的话可能导致服务器资源耗尽。

### 并发模型

```
                    ┌─────────────────────────────┐
                    │      并发控制器               │
                    │   maxConcurrent = 3          │
                    │   queueSize = 50             │
                    └─────────────────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
    ┌───────────┐          ┌───────────┐          ┌───────────┐
    │ Slot 1    │          │ Slot 2    │          │ Slot 3    │
    │ 正在处理   │          │ 正在处理   │          │ 正在处理   │
    │ 用户 A     │          │ 用户 B     │          │ 用户 C     │
    └───────────┘          └───────────┘          └───────────┘
    
    等待队列 FIFO: [用户 D] → [用户 E] → [用户 F] → ... (最多 50 个)
```

### 排队规则

| 场景 | 行为 |
|------|------|
| 3 个槽位全空闲 | 请求直接进入空闲槽位，立即开始处理 |
| 所有槽位被占用 | 新请求进入 FIFO 队列排队等待 |
| 队列已满（50 个） | 拒绝新请求，回复"当前请求较多，请稍后再试" |
| 同一会话重复发消息 | 并发锁跳过（上一个请求还在处理中） |

### 并发锁

同一会话（如同一用户在同一个群聊中）同时只能处理一条消息：

```
用户 A 在群里连续发了 3 条 @机器人 的消息：
  消息 1: @机器人 查一下 xxx     → 开始处理
  消息 2: @机器人 再查一下 yyy   → 跳过（消息 1 还在处理）
  消息 3: @机器人 还有 zzz       → 跳过（消息 1 还在处理）
  
消息 1 处理完毕后，A 可以发送新消息继续对话。
```

## 功能特性

### 消息处理
- **流式回复**：Claude 输出实时分段推送到企业微信，500ms 节流
- **文件/图片接收**：FileBroker 自动下载 + AES-256-CBC 解密 → 沙箱存储 → Claude Read 可读
- **文件/图片发送**：`[FILE_OUTPUT]` 协议提取 → 沙箱写入 → WebSocket 三阶段上传 → 直发 WeCom
- **消息去重**：msgId 去重（30s 窗口）+ 内容哈希去重（10s 窗口），防止企业微信重复回调
- **发送冷却**：3s 内同内容不重复发送
- **自动截断**：超 4000 字节自动截断（企业微信 markdown 限制 4096 字节）
- **群聊 @ 过滤**：只在被 @ 机器人名称时回复，支持自定义名称
- **白名单**：支持按用户 ID 限制可访问的用户
- **文件竞态处理**：文字和文件同时到达时，文件上下文缓存等待文字消息注入

### 会话管理
- **群聊隔离**：群聊中每人独立会话线程（`group:<chatid>:<userid>`），互不影响
- **私聊独立**：每个私聊用户独立会话（`private:<userid>`）
- **自动过期**：2h 无活动自动清理，历史限制 50 条（保留最新 40 条）
- **会话重置**：`/reset` 或 `/clear` 指令清除对话历史

### 并发控制
- **最大并发**：默认 3 个请求同时处理（可通过配置调整）
- **排队机制**：超出的请求进入 FIFO 队列（默认 50），队列满则拒绝
- **并发锁**：同一会话同时只处理一条消息，新消息被跳过

### 高可用
- **WebSocket 长连接**：30s 心跳，断线自动重连（指数退避，最多 10 次）
- **进程守护**：PM2 管理，崩溃自动重启，内存超限重启（500MB）
- **开机自启**：systemd 服务，服务器重启后自动恢复

### 安全隔离

| 层级 | 机制 | 说明 |
|------|------|------|
| 1 | `--allowedTools` | Claude 仅允许 Read、Grep、Glob、WebSearch、WebFetch |
| 2 | `--add-dir /tmp/wecom-sandbox` | 额外可读沙箱目录（仅 FileBroker 可写） |
| 3 | 系统提示词 | 声明只读环境 + `[FILE_OUTPUT]` 协议说明 |
| 4 | FileBroker 沙箱 | 文件操作限定沙箱，8 项安全校验 |
| 5 | TTL 自动清理 | 5 分钟后自动删除沙箱文件 |

## 前置条件

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | ≥ 18 | 运行环境 |
| Claude Code | 已安装并认证 | 通过 `claude --version` 确认 |
| 企业微信 AI 机器人 | — | 需已创建并获取 botId + secret |

### 企业微信 AI 机器人创建

1. 登录企业微信管理后台 → 应用管理 → AI 机器人
2. 创建机器人，获取 `bot_id` 和 `secret`
3. 将机器人添加到需要使用的群聊中

### Claude Code 认证

确保服务器上已登录 Claude Code：
```bash
claude --version   # 确认 claude 可用
claude             # 首次需完成 OAuth 认证
```

## 安装

### 1. 获取代码

```bash
git clone <repo-url>
cd wecom-chat-agent
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置

```bash
cp .env.example .env
```

编辑 `.env`，填入必填项：

```bash
# 必填
WECOM_BOT_ID=your_bot_id_here
WECOM_SECRET=your_secret_here

# 可选
BOT_NAME=your_bot_name
```

### 4. 启动验证

```bash
node main.js
```

看到以下输出即表示启动成功：
```
✅ WebSocket 已连接
✅ 认证成功，启动心跳...
✅ WebSocket 已连接，等待消息...
```

## 配置参考

### .env / 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `WECOM_BOT_ID` | **是** | — | 企业微信 AI 机器人 ID |
| `WECOM_SECRET` | **是** | — | 企业微信 AI 机器人 Secret |
| `BOT_NAME` | 否 | `<your-bot-name>` | 机器人名称（群聊 @ 过滤用） |
| `ALLOWED_USERS` | 否 | 空（允许所有） | 白名单用户 ID，逗号分隔 |
| `GROUP_CHAT_ENABLED` | 否 | `true` | 是否启用群聊回复 |
| `PRIVATE_CHAT_ENABLED` | 否 | `true` | 是否启用私聊回复 |
| `STREAM_THROTTLE_MS` | 否 | `500` | 流式推送节流间隔（毫秒） |
| `HEARTBEAT_INTERVAL` | 否 | `30000` | 心跳间隔（毫秒） |
| `MAX_CONCURRENT` | 否 | `3` | 最大并发处理请求数 |
| `QUEUE_SIZE` | 否 | `50` | 排队队列最大长度 |

### Claude Code 模型配置

通过 Claude Code 的 `settings.json` 指定模型，系统提示词和工具限制由代码内建。

如需使用第三方 API 代理（如 DeepSeek），在启动环境变量中设置：

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=your_api_key
ANTHROPIC_MODEL=deepseek-v4-pro
```

### 超时与性能

| 参数 | 值 | 说明 |
|------|-----|------|
| Claude 响应超时 | 5 分钟 | `claude -p --bare` 最大等待时间 |
| 会话 TTL | 2 小时 | 无活动自动过期 |
| 消息历史上限 | 50 条 | 超过后保留最新 40 条 |
| 发送冷却 | 3 秒 | 同内容不重复发送 |
| 流式推送节流 | 500ms | 两次推送最小间隔 |
| 去重窗口（msgId） | 30 秒 | 相同 msgId 忽略 |
| 去重窗口（内容哈希） | 10 秒 | 相同内容忽略 |

## 生产部署（PM2 + systemd）

### 1. 安装 PM2

```bash
npm install -g pm2
```

### 2. 创建 ecosystem 配置

创建 `ecosystem.config.js`（根据实际路径调整 `cwd` 和日志路径）：

```javascript
module.exports = {
  apps: [{
    name: 'wecom-chat-agent',
    namespace: 'wecom',
    script: 'main.js',
    cwd: '/opt/wecom-chat-agent',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    error_file: '/var/log/wecom-chat-agent/error.log',
    out_file: '/var/log/wecom-chat-agent/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      // 以下按需配置
      // ANTHROPIC_BASE_URL: '...',
      // ANTHROPIC_AUTH_TOKEN: '...',
      // ANTHROPIC_MODEL: '...',
    },
  }],
};
```

### 3. 创建独立的 PM2 实例（推荐）

为避免与其他项目的 PM2 进程混在一起，使用独立的 `PM2_HOME`：

```bash
# 创建独立 PM2 数据目录
mkdir -p /opt/wecom-chat-agent/.pm2

# 启动
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 start /opt/wecom-chat-agent/ecosystem.config.js

# 保存进程列表
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 save
```

### 4. 创建 systemd 服务

创建 `/etc/systemd/system/pm2-wecom.service`：

```ini
[Unit]
Description=PM2 process manager for wecom-chat-agent
After=network.target

[Service]
Type=forking
User=root
LimitNOFILE=infinity
LimitNPROC=infinity
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PM2_HOME=/opt/wecom-chat-agent/.pm2
PIDFile=/opt/wecom-chat-agent/.pm2/pm2.pid
Restart=on-failure

ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable pm2-wecom
systemctl start pm2-wecom
```

### 5. 日常管理命令

```bash
# 查看状态
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 status

# 查看日志
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 logs

# 重启
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 restart wecom-chat-agent

# 停止
PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 stop wecom-chat-agent

# 查看实时日志
tail -f /var/log/wecom-chat-agent/out.log
tail -f /var/log/wecom-chat-agent/error.log
```

## 使用指南

### 群聊

在群聊中 @机器人名称 即可对话：

```
@<机器人名称> 你好，介绍一下自己
@<机器人名称> 帮我查一下知识库里有没有关于部署的文档
@<机器人名称> 上面那篇部署文档里提到的配置项有哪些？
```

同一用户在群聊中的连续 @ 会共享上下文，机器人会记住之前的对话。

### 私聊

直接发送消息即可，不需要 @。每个用户的私聊拥有独立上下文。

```
/help    — 查看帮助和指令列表
/status  — 查看服务状态
```

### 内置指令

| 指令 | 功能 |
|------|------|
| `/help` | 显示帮助信息 |
| `/reset` | 重置当前会话（清除对话历史） |
| `/clear` | 同 /reset |
| `/status` | 显示服务状态 |

## 故障排查

### 机器人不回复

1. **确认服务状态**
   ```bash
   PM2_HOME=/opt/wecom-chat-agent/.pm2 pm2 status
   ```

2. **查看日志**
   ```bash
   tail -f /var/log/wecom-chat-agent/out.log
   ```

3. **常见原因**
   - 检查 `.env` 中 botId / secret 是否正确
   - 确认机器人已添加到群聊
   - 确认群聊中 @ 的名称与 `BOT_NAME` 配置一致
   - Websocket 连接：查找 `✅ 认证成功` 日志

### 回复 "处理失败: Cannot read properties of undefined"

通常是代码初始化问题，检查：
1. `concurrency-limiter.js` 文件是否存在
2. `message-dispatcher.js` 构造函数中是否初始化了 `this._concurrencyLimiter`
3. 如有问题，重启服务：`PM2_HOME=... pm2 restart wecom-chat-agent`

### 回复超时

如果频繁出现超时（默认 5 分钟），可能原因：
- Claude Code 模型响应过慢
- 知识库文件过多，搜索耗时
- 可适当增大超时时间（修改 `claude-orchestrator.js` 中 `300000` 值）

### 重复回复

内置了三层去重机制：
1. msgId 去重（30s）
2. 内容哈希去重（10s）
3. 发送冷却（3s）

如果仍有重复，检查是否有多个 node 进程在运行。

### 进程频繁重启

```bash
# 查错误日志
tail -100 /var/log/wecom-chat-agent/error.log

# 常见错误：
# - "请求超时" → 认证超时，已内置自动重连
# - "claude 进程错误" → claude 命令不可用，检查 claude --version
# - "队列已满" → 并发请求过多
```

## 开发

### 文件结构

```
wecom-chat-agent/
├── main.js                    # 入口，组件装配
├── wecom-ws-client.js         # WebSocket 客户端（连接、认证、心跳、重连）
├── claude-orchestrator.js     # Claude CLI 编排器（spawn 子进程、流式读取、E2BIG 防护）
├── message-dispatcher.js      # 消息分发器（去重、@过滤、指令、排队、推送、竞态防护）
├── session-manager.js         # 会话管理（内存存储、TTL 过期）
├── concurrency-limiter.js     # 并发控制器（FIFO 队列 + TTL 超时保护）
├── file-broker.js             # FileBroker 安全沙箱（文件下载、AES 解密、EML 解析）
├── file-converter.js          # Office 文档格式转换（.docx→.md / .xlsx→.csv / .pptx→.txt）
├── eml-parser.js              # EML 邮件解析（MIME 解码、附件提取）
├── config.js                  # 配置加载（.env / config.json / 环境变量）
├── deploy.sh                  # Linux 自动部署脚本
├── deploy.ps1                 # Windows 自动部署脚本
├── package.json
├── ecosystem.config.example.js  # PM2 部署配置模板（无密钥）
├── .env.example               # 环境变量模板
├── settings.json              # Claude Code 模型配置
├── README.md                  # 本文档
├── DEPLOY.md                  # 部署说明书
└── WORKFLOW.md                # 开发工作流
```

### 安全注意事项

- `.env` 文件包含 botId 和 secret，**不要提交到 Git**
- ecosystem.config.js 中的 API key 注意保密
- 机器人运行在只读沙箱中，无法修改文件或执行命令

## 许可证

MIT
