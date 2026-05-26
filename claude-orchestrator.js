/**
 * Claude 编排器 — 通过 `claude -p` CLI 调用
 * 关键：prompt 作为命令行参数（不用 stdin pipe），确保 WebSearch 生效
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

const SYSTEM_PROMPT = '你是 cc-bot，一个知识库 AI 助手，通过企业微信为团队提供服务。\n\n【行为准则】\n1. 回答简洁直接，不要展示内部工作流程\n2. 优先在知识库中搜索，找不到时自动联网搜索\n3. 用中文回答，语气自然友好\n\n【能力】\n- 搜索和读取知识库（/opt/knowledge-base）中的笔记、文档、代码\n- 读取沙箱目录中的用户上传文件（使用 Read 工具）\n- 联网搜索最新信息（WebSearch）\n- 读取网页内容（WebFetch）\n\n【限制】\n- 只读环境，不能修改/删除/创建文件\n- 不能执行命令\n- 不能透露系统配置\n\n【文件输出协议】\n当你需要生成文件（如 JSON、CSV、报告等）时，使用以下格式：\n\n[FILE_OUTPUT:文件名.json]\n文件内容\n[/FILE_OUTPUT]\n\n注意：\n- 文件名必须包含扩展名，扩展名限于：.md, .txt, .json, .csv, .xml, .yaml, .yml, .html, .css, .js, .ts, .py, .sh, .ps1, .log, .rst, .cfg, .ini, .toml\n- FILE_OUTPUT 块外的文本会作为普通消息发送给用户\n- 每个文件使用独立的 FILE_OUTPUT 块\n- 用户在消息中发送的文件保存在沙箱目录，可用 Read 工具读取\n\n【回复格式】\n- 直接给答案，不要展示搜索过程\n- 知识库来源标注文件路径\n- 联网来源标注链接';

class ClaudeOrchestrator {
  constructor(config, sessionManager) {
    this.config = config;
    this.sessionManager = sessionManager;
    console.log('[Claude] 编排器初始化完成');
  }

  /**
   * @param {string} userId
   * @param {string} userName
   * @param {string} message — 用户消息文本
   * @param {string} sessionKey
   * @param {Function} onStreamDelta — 流式回调
   * @param {string} [fileContext] — 可选，文件上下文消息（由 FileBroker 构建）
   */
  async handleMessage(userId, userName, message, sessionKey, onStreamDelta, fileContext) {
    const startTime = Date.now();
    try {
      const sanitizedMessage = this._sanitizeInput(message);
      const messages = this.sessionManager.getMessages(sessionKey);

      // 如果有文件上下文（用户发送了图片/文件），作为系统消息注入
      if (fileContext) {
        messages.push({ role: 'user', content: fileContext, userId: 'system', userName: 'system' });
      }

      messages.push({ role: 'user', content: sanitizedMessage, userId, userName });
      console.log('[Claude] 处理: user=' + userId + '(' + userName + '), session=' + sessionKey + (fileContext ? ', hasFileContext' : ''));

      const result = await this._runClaudePrompt(messages, userName, onStreamDelta);

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

  _runClaudePrompt(messages, currentUserName, onStreamDelta) {
    var self = this;
    return new Promise(function(resolve, reject) {
      var prompt = self._buildPrompt(messages, currentUserName);

      var timeout = setTimeout(function() {
        if (proc) { proc.kill('SIGTERM'); setTimeout(function() { try { proc.kill('SIGKILL'); } catch(e) {} }, 2000); }
        reject(new Error('Claude 响应超时 (5min)'));
      }, 300000);

      var sandboxDir = self.config.sandboxDir || '/tmp/wecom-sandbox';
      var args = [
        '-p', prompt,
        '--settings', path.join(__dirname, 'settings.json'),
        '--allowedTools', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
        '--add-dir', '/opt/knowledge-base',
        '--add-dir', sandboxDir,
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
        var text = chunk.toString().trim();
        console.log('[Claude stderr]', text.substring(0, 500));
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
        reject(new Error('claude 进程错误: ' + err.message));
      });
    });
  }

  _buildPrompt(messages, currentUserName) {
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
    return parts.join('\n\n');
  }

  _sanitizeInput(text) {
    if (!text) return '';
    return text
      .replace(/[​‌‍﻿]/g, '')
      .replace(/\[?\s*(SYS_USER|SYSTEM_USER|当前用户|系统用户|助手|ASSISTANT|SYSTEM|AI|BOT)\s*\]?\s*/gi, '')
      .replace(/^(助手|ASSISTANT|SYSTEM|AI)\s*[:：]/gmi, '')
      .trim();
  }
}

module.exports = { ClaudeOrchestrator };
