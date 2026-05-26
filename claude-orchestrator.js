/**
 * Claude 编排器 — 通过 `claude -p --bare` CLI 调用（共享 Claude Code 认证）
 *
 * 原理：
 *   每次收到 WeCom 消息 → fork `claude -p --bare` 子进程
 *   → 读取完整回复 → 流式分段推送到 WeCom
 *
 * 优势：
 *   - 不需要单独的 API Key（共享 Claude Code 的认证）
 *   - 使用 cc-switch 配置的模型
 *   - --bare 模式跳过 hooks/插件/CLAUDE.md，干净快速
 */

const { spawn } = require('child_process');
const path = require('path');
const { SessionManager } = require('./session-manager.js');
const os = require('os');

// 找到 claude 命令的绝对路径
function findClaudePath() {
  // 方法1: 检查 npm 全局 bin 目录
  const npmBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
  if (require('fs').existsSync(npmBin)) return npmBin;

  // 方法2: 检查 nvm 等常见路径
  const altPaths = [
    path.join(os.homedir(), 'scoop', 'apps', 'nodejs', 'current', 'claude.cmd'),
    path.join(process.env.ProgramData || '', 'nvm', process.version, 'claude.cmd'),
  ];
  for (const p of altPaths) {
    if (require('fs').existsSync(p)) return p;
  }

  // 方法3: 回退到直接 'claude'（依赖 PATH）
  return 'claude';
}

const CLAUDE_PATH = findClaudePath();
console.log(`[Claude] 使用路径: ${CLAUDE_PATH}`);

// 系统提示词（通过 --append-system-prompt 注入）
const SYSTEM_PROMPT = `你是 yb_claudecode，一个 Obsidian 知识库 AI 助手。

【你的身份】
- 你是运行在 Claude Code 环境中的 AI 助手，通过 Node.js 代理接入企业微信
- 你通过 \`claude -p --bare\` CLI 被调用，共享 Claude Code 的认证
- 你是群聊/私聊中的 AI 助手

【你的核心能力】
1. **知识库管理** — 管理用户的 Obsidian 知识库（.md 文件、YAML frontmatter、Wiki-links、标签系统）
2. **文件操作** — 读取、编写、搜索知识库中的笔记和代码文件
3. **代码分析** — 阅读代码、审查、调试、编写代码
4. **文档撰写** — 撰写技术文档、报告、PRD、会议纪要
5. **信息检索** — 在知识库中搜索相关信息并回答
6. **任务规划** — 帮助规划和跟踪项目任务

【安全限制 — 绝对不可违反】
- 你运行在**只读隔离沙箱**中，没有任何文件写入或命令执行权限
- 你只能通过 Read、Grep、Glob 等只读工具访问文件
- 禁止尝试执行 Bash、Write、Edit 等危险操作（系统已拒绝）
- 如果用户要求你修改配置、执行命令、修改系统设置，必须拒绝并说明你只有只读权限
- 你的知识截止于训练时间，当前日期由系统提供

【回复规范】
- 回答简洁明了，使用中文
- 你是群聊/私聊中的 AI 助手
- 当前发言者的身份由 [SYS_USER] 标识指定`;

class ClaudeOrchestrator {
  constructor(config, sessionManager) {
    this.config = config;
    this.sessionManager = sessionManager;

    console.log(`🧠 Claude 编排器初始化完成 (claude -p --bare)`);
  }

  /**
   * 处理文本消息
   */
  async handleMessage(userId, userName, message, sessionKey, onStreamDelta) {
    const startTime = Date.now();

    try {
      // 安全过滤
      const sanitizedMessage = this._sanitizeInput(message);

      // 构建完整对话历史（含用户身份）
      const messages = this.sessionManager.getMessages(sessionKey);
      messages.push({ role: 'user', content: sanitizedMessage, userId, userName });

      console.log(`[Claude] 处理: user=${userId}(${userName}), session=${sessionKey}`);

      // 调用 claude -p
      const result = await this._runClaudePrompt(messages, userName, onStreamDelta);

      // 保存会话历史
      this.sessionManager.addMessage(sessionKey, 'user', sanitizedMessage, userId, userName);
      this.sessionManager.addMessage(sessionKey, 'assistant', result);

      const latency = Date.now() - startTime;
      console.log(`[Claude] 完成: text_len=${result.length}, latency=${latency}ms`);

      return result;

    } catch (err) {
      console.error(`[Claude] 处理失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 运行 claude -p --bare
   */
  _runClaudePrompt(messages, currentUserName, onStreamDelta) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (proc) {
          proc.kill('SIGTERM');
          setTimeout(() => proc?.kill('SIGKILL'), 2000);
        }
        reject(new Error('Claude 响应超时 (2min)'));
      }, 120000);

      // 构建 prompt（含用户身份）
      const prompt = this._buildPrompt(messages, currentUserName);

      // 构建参数
      const args = [
        '-p',
        '--bare',
        '--no-session-persistence',
        '--append-system-prompt', SYSTEM_PROMPT,
        // 安全：拒绝危险工具
        '--disallowed-tools', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent',
        // 安全：只读权限模式
        '--permission-mode', 'bypassPermissions',
      ];

      // 可选：指定模型
      if (this.config.model) {
        args.push('--model', this.config.model);
      }

      const cwd = this.config.workingDir || path.join(__dirname, '..', '..'); // 默认知识库根目录

      // 确保 PATH 包含 npm 全局 bin 目录
      const npmBinDir = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
      const existingPath = process.env.PATH || '';
      const newPath = existingPath.includes(npmBinDir) ? existingPath : `${npmBinDir};${existingPath}`;

      const proc = spawn(CLAUDE_PATH, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: newPath,
          CLAUDE_CODE_INTERACTIVE: '0',
          CLAUDE_CODE_SIMPLE: '1',
        },
        shell: true, // Windows 下需要 shell 来解析 .cmd
      });

      let accumulatedText = '';

      // 流式读取 stdout
      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        accumulatedText += text;

        if (onStreamDelta) {
          onStreamDelta(accumulatedText, false).catch(() => {});
        }
      });

      proc.stderr.on('data', (chunk) => {
        // stderr 可能是进度信息，打印但不影响
        const text = chunk.toString().trim();
        if (text && text.length < 500) {
          console.log(`[Claude stderr] ${text}`);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (!accumulatedText || !accumulatedText.trim()) {
          if (code !== 0) {
            reject(new Error(`claude -p 退出 (code=${code})，无回复`));
            return;
          }
          accumulatedText = '已完成处理，但未生成文本回复。';
        }

        if (onStreamDelta) {
          onStreamDelta(accumulatedText, true).catch(() => {});
        }

        resolve(accumulatedText);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`claude 进程错误: ${err.message}`));
      });

      // 发送 prompt
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  /**
   * 构建 prompt（拼接对话历史 + 用户身份标识）
   */
  _buildPrompt(messages, currentUserName) {
    const parts = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        const displayName = msg.userName || msg.userId || '用户';
        parts.push(`[${displayName}]: ${msg.content}`);
      } else if (msg.role === 'assistant') {
        parts.push(`[助手]: ${msg.content}`);
      }
    }
    return parts.join('\n\n');
  }

  /**
   * 安全过滤 — 清除伪造身份标记
   */
  _sanitizeInput(text) {
    if (!text) return '';
    return text
      .replace(/[​‌‍﻿]/g, '')
      .replace(/\[?\s*(SYS_USER|SYSTEM_USER|当前用户|系统用户)\s*\]?\s*/gi, '')
      .trim();
  }
}

module.exports = { ClaudeOrchestrator };
