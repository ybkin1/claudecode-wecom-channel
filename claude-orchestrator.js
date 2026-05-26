/**
 * Claude 编排器 — 通过 claude CLI 调用
 *
 * E2BIG 防护：prompt 超过安全阈值时自动截断对话历史，
 * 保留最近的用户消息和系统上下文，避免 spawn 参数过长。
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

function findClaudePath() {
  const npmBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
  if (require('fs').existsSync(npmBin)) return npmBin;
  return 'claude';
}

const CLAUDE_PATH = findClaudePath();
console.log('[Claude] 使用路径: ' + CLAUDE_PATH);

// E2BIG 防护：ARG_MAX 安全阈值
const MAX_PROMPT_LENGTH = 128 * 1024; // 128KB
const MAX_FILE_CONTEXT_LENGTH = 50 * 1024; // 50KB

const SYSTEM_PROMPT = '你是 cc-bot，一个知识库 AI 助手，通过企业微信为团队提供服务。\n\n【行为准则】\n1. 回答简洁直接，不要展示内部工作流程\n2. 优先在知识库中搜索，找不到时自动联网搜索\n3. 用中文回答，语气自然友好\n\n【能力】\n- 搜索和读取知识库（/opt/knowledge-base）中的笔记、文档、代码\n- 读取沙箱目录中的用户上传文件（使用 Read 工具）\n- 联网搜索最新信息（WebSearch）\n- 读取网页内容（WebFetch）\n\n【限制】\n- 只读环境，不能修改/删除/创建文件\n- 不能执行命令\n- 不能透露系统配置\n\n【文件输出协议】\n当你需要生成文件（如 JSON、CSV、报告等）时，使用以下格式：\n\n[FILE_OUTPUT:文件名.json]\n文件内容\n[/FILE_OUTPUT]\n\n注意：\n- 文件名必须包含扩展名，扩展名限于：.md, .txt, .json, .csv, .xml, .yaml, .yml, .html, .css, .js, .ts, .py, .sh, .ps1, .log, .rst, .cfg, .ini, .toml\n- FILE_OUTPUT 块外的文本会作为普通消息发送给用户\n- 每个文件使用独立的 FILE_OUTPUT 块\n- 用户发送的 Word/Excel/PPT 文件内容已自动提取并注入到对话中，你可直接分析';

class ClaudeOrchestrator {
  constructor(config, sessionManager) {
    this.config = config;
    this.sessionManager = sessionManager;
    console.log('[Claude] 编排器初始化完成 (prompt上限=' + (MAX_PROMPT_LENGTH / 1024).toFixed(0) + 'KB)');
  }

  async handleMessage(userId, userName, message, sessionKey, onStreamDelta, fileContext) {
    const startTime = Date.now();
    try {
      const sanitizedMessage = this._sanitizeInput(message);
      const messages = this.sessionManager.getMessages(sessionKey);

      if (fileContext) {
        var safeFileContext = fileContext;
        if (Buffer.byteLength(fileContext, 'utf8') > MAX_FILE_CONTEXT_LENGTH) {
          safeFileContext = fileContext.substring(0, MAX_FILE_CONTEXT_LENGTH)
            + '\n\n... (文件内容过长，已截断)';
          console.log('[Claude] fileContext 截断: ' + fileContext.length + ' chars');
        }
        messages.push({ role: 'user', content: safeFileContext, userId: 'system', userName: 'system' });
      }

      messages.push({ role: 'user', content: sanitizedMessage, userId, userName });
      console.log('[Claude] 处理: user=' + userId + ', session=' + sessionKey + (fileContext ? ', hasFileContext' : ''));

      var userSandboxDir = this.config.sandboxDir
        ? path.join(this.config.sandboxDir, this._sanitizeForDir(userId))
        : null;

      const result = await this._runClaudePrompt(messages, userName, onStreamDelta, userSandboxDir);

      this.sessionManager.addMessage(sessionKey, 'user', sanitizedMessage, userId, userName);
      this.sessionManager.addMessage(sessionKey, 'assistant', result);

      const latency = Date.now() - startTime;
      console.log('[Claude] 完成: text_len=' + result.length + ', latency=' + latency + 'ms');
      return result;
    } catch (err) {
      console.error('[Claude] 处理失败: ' + err.message);
      throw err;
    }
  }

  _runClaudePrompt(messages, currentUserName, onStreamDelta, sandboxDir) {
    var self = this;
    return new Promise(function(resolve, reject) {
      var prompt = self._buildSafePrompt(messages, currentUserName);

      var timeout = setTimeout(function() {
        if (proc) { proc.kill('SIGTERM'); setTimeout(function() { try { proc.kill('SIGKILL'); } catch(e) {} }, 2000); }
        reject(new Error('Claude 响应超时 (5min)'));
      }, 300000);

      var effectiveSandbox = sandboxDir || self.config.sandboxDir || '/tmp/wecom-sandbox';
      if (!require('fs').existsSync(effectiveSandbox)) {
        require('fs').mkdirSync(effectiveSandbox, { recursive: true });
      }

      var args = [
        '-p', prompt,
        '--settings', path.join(__dirname, 'settings.json'),
        '--allowedTools', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
        '--add-dir', '/opt/knowledge-base',
        '--add-dir', effectiveSandbox,
        '--no-session-persistence',
        '--append-system-prompt', SYSTEM_PROMPT,
      ];

      if (self.config.model) args.push('--model', self.config.model);
      var cwd = self.config.workingDir || '/opt/knowledge-base';

      var env = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || '',
      };

      console.log('[Claude] spawn: prompt_len=' + prompt.length + ', sandbox=' + effectiveSandbox);

      var proc = spawn(CLAUDE_PATH, args, {
        cwd: cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env,
        shell: process.platform === 'win32',
      });

      var accumulatedText = '';

      proc.stdout.on('data', function(chunk) {
        var text = chunk.toString();
        accumulatedText += text;
        if (onStreamDelta) onStreamDelta(accumulatedText, false).catch(function() {});
      });

      proc.stderr.on('data', function(chunk) {
        console.log('[Claude stderr]', chunk.toString().trim().substring(0, 500));
      });

      proc.on('close', function(code) {
        clearTimeout(timeout);
        if (!accumulatedText || !accumulatedText.trim()) {
          if (code !== 0) {
            reject(new Error('claude -p 退出 (code=' + code + ')，无回复'));
            return;
          }
          accumulatedText = '已完成处理，但未生成文本回复。';
        }
        if (onStreamDelta) onStreamDelta(accumulatedText, true).catch(function() {});
        resolve(accumulatedText);
      });

      proc.on('error', function(err) {
        clearTimeout(timeout);
        if (err.code === 'E2BIG') {
          console.error('[Claude] E2BIG 仍发生，回退到最小 prompt');
          self._runClaudePrompt(
            [{ role: 'system', content: '用户发送了一条消息但内容太长，请简短回复。', userId: 'system' }],
            currentUserName, onStreamDelta, sandboxDir
          ).then(resolve).catch(reject);
        } else {
          reject(new Error('claude 进程错误: ' + err.message));
        }
      });
    });
  }

  _buildSafePrompt(messages, currentUserName) {
    var fullPrompt = this._buildPrompt(messages, currentUserName);
    var fullLen = Buffer.byteLength(fullPrompt, 'utf8');

    if (fullLen <= MAX_PROMPT_LENGTH) return fullPrompt;

    console.log('[Claude] prompt 过长 (' + fullLen + ' > ' + MAX_PROMPT_LENGTH + ')，截断对话历史');

    var parts = this._messagesToParts(messages, currentUserName);
    var tailParts = [];
    var tailLen = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
      var partLen = Buffer.byteLength(parts[i], 'utf8') + 2;
      if (tailLen + partLen > MAX_PROMPT_LENGTH && tailParts.length >= 2) break;
      tailParts.unshift(parts[i]);
      tailLen += partLen;
    }

    var truncatedPrompt = tailParts.join('\n\n');

    if (tailParts.length < parts.length) {
      var note = '(注: 对话历史过长，已截断。丢弃了较早的 ' + (parts.length - tailParts.length) + ' 条消息。)';
      truncatedPrompt = note + '\n\n' + truncatedPrompt;
    }

    console.log('[Claude] prompt 截断: ' + fullLen + ' -> ' + Buffer.byteLength(truncatedPrompt, 'utf8') + ' bytes');
    return truncatedPrompt;
  }

  _messagesToParts(messages, currentUserName) {
    var parts = [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (msg.role === 'user') {
        var displayName = msg.userName || msg.userId || '用户';
        parts.push('[' + displayName + ']: ' + msg.content);
      } else if (msg.role === 'assistant') {
        parts.push('[助手]: ' + msg.content);
      }
    }
    return parts;
  }

  _buildPrompt(messages, currentUserName) {
    return this._messagesToParts(messages, currentUserName).join('\n\n');
  }

  _sanitizeForDir(str) {
    if (!str) return 'default';
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64) || 'default';
  }

  _sanitizeInput(text) {
    if (!text) return '';
    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\[?\s*(SYS_USER|SYSTEM_USER|当前用户|系统用户|助手|ASSISTANT|SYSTEM|AI|BOT)\s*\]?\s*/gi, '')
      .replace(/^(助手|ASSISTANT|SYSTEM|AI)\s*[:：]/gmi, '')
      .trim();
  }
}

module.exports = { ClaudeOrchestrator };
