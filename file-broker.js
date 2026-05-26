/**
 * FileBroker — 企业微信文件安全读写中间层
 *
 * 安全隔离 Claude 子进程的只读环境与文件写入能力：
 * - 所有文件写入沙箱目录（UUID 命名，扩展名白名单，TTL 自动清理）
 * - 路径遍历攻击自动拦截
 * - 符号链接攻击自动拦截
 *
 * 安全设计原则：
 * - Claude 子进程：只读（Read/Grep/Glob），不能修改文件系统
 * - FileBroker：受限写（沙箱内，UUID 命名，白名单扩展名，TTL 清理）
 *
 * 用法：
 *   const broker = new FileBroker({ sandboxDir: '/tmp/wecom-sandbox' });
 *   const entry = await broker.downloadAndStore('https://...', 'photo.jpg');
 *   const { cleanText, files } = broker.parseFileOutputs(claudeResponse);
 *   broker.cleanupAll(); // 进程退出时调用
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─── 配置常量 ───

/** 输出文件扩展名白名单（writeContent 使用） */
const DEFAULT_ALLOWED_EXTENSIONS = [
  '.md', '.txt', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.html', '.css', '.js', '.ts', '.py', '.sh', '.ps1',
  '.log', '.rst', '.cfg', '.ini', '.toml',
];

/** 默认 TTL：5 分钟 */
const DEFAULT_FILE_TTL_MS = 5 * 60 * 1000;

/** 默认文件大小上限：10 MB */
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

// ─── FileBroker 类 ───

class FileBroker {
  /**
   * @param {Object} options
   * @param {string}  [options.sandboxDir='/tmp/wecom-sandbox'] 沙箱根目录
   * @param {string[]} [options.allowedExtensions] 输出扩展名白名单
   * @param {number} [options.fileTtlMs=300000] 文件 TTL（ms），超时自动删除
   * @param {number} [options.maxFileSize=10485760] 下载文件最大字节数
   */
  constructor(options) {
    if (!options) options = {};
    this.sandboxDir = options.sandboxDir || '/tmp/wecom-sandbox';
    this.allowedExtensions = options.allowedExtensions || DEFAULT_ALLOWED_EXTENSIONS;
    this.fileTtlMs = options.fileTtlMs || DEFAULT_FILE_TTL_MS;
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;

    // 确保沙箱目录存在
    this._ensureSandboxDir();

    // TTL 追踪：absolutePath → timerId
    this._ttlTimers = new Map();

    console.log('[FileBroker] 沙箱目录:', this.sandboxDir);
    console.log('[FileBroker] 输出扩展名白名单:', this.allowedExtensions.join(', '));
    console.log('[FileBroker] TTL:', this.fileTtlMs, 'ms, 最大文件大小:', this.maxFileSize, 'bytes');
  }

  // ══════════════════════════════════════════════════
  //  公共 API
  // ══════════════════════════════════════════════════

  /**
   * 从 URL 下载文件并存储到沙箱
   *
   * 安全保证：
   * - UUID 随机文件名（用户不可控，防覆盖/猜测攻击）
   * - 保留原始扩展名（接收场景宽松，仅用于文件类型识别）
   * - 大小限制 maxFileSize
   * - 自动注册 TTL 清理定时器
   *
   * @param {string} url — WeCom 回调中的图片/文件下载 URL
   * @param {string} [originalFilename] — 原始文件名（用于提取扩展名）
   * @param {string} [mimeHint] — MIME 类型提示（备用扩展名推断）
   * @returns {Promise<FileEntry>}
   */
  /**
   * @param {string} [aeskey] — WeCom 文件回调中的 AES-256-CBC 解密密钥 (base64)，有则解密
   */
  async downloadAndStore(url, originalFilename, mimeHint, aeskey) {
    // 提取扩展名（接收场景宽松，不检查白名单）
    var extension = '';
    if (originalFilename) {
      extension = this._extractExtension(originalFilename);
    }
    if (!extension && mimeHint) {
      extension = this._mimeToExtension(mimeHint);
    }
    if (!extension) {
      extension = '.bin';
    }

    var sandboxPath = this._generateSandboxPath(extension);

    try {
      var content = await this._httpDownload(url);

      // WeCom 文件回调携带 aeskey → AES-256-CBC 解密
      if (aeskey) {
        content = this._decryptAESFile(content, aeskey);
        console.log('[FileBroker] downloadAndStore: AES 解密完成, ' + content.length + ' bytes (原始加密 ' + (content.length + 30) + ' bytes)');
      }

      // 大小限制检查
      if (content.length > this.maxFileSize) {
        throw new Error('文件大小 ' + content.length + ' bytes 超过限制 ' + this.maxFileSize + ' bytes');
      }

      fs.writeFileSync(sandboxPath, content);

      // 注册 TTL 清理
      this._scheduleCleanup(sandboxPath);

      console.log('[FileBroker] downloadAndStore: ' + sandboxPath + ' (' + content.length + ' bytes)');

      return { sandboxPath, originalFilename, extension, size: content.length };
    } catch (err) {
      // 下载失败时清理可能的残留文件
      try { fs.unlinkSync(sandboxPath); } catch (e) { /* ignore */ }
      throw new Error('文件下载/存储失败: ' + err.message);
    }
  }

  /**
   * 将内容写入沙箱（用于 Claude 生成的 [FILE_OUTPUT] 文件）
   *
   * 安全保证：
   * - 扩展名必须在 allowedExtensions 白名单内
   * - UUID 随机文件名（用户不可控）
   * - 自动注册 TTL 清理定时器
   *
   * @param {string} extension — 文件扩展名（含点，如 '.json'）
   * @param {string} content — 文件内容（UTF-8）
   * @param {Object} [metadata] — 额外元数据
   * @returns {Promise<FileEntry>}
   */
  async writeContent(extension, content, metadata) {
    // 扩展名白名单校验
    var validatedExt = this._validateExtension(extension);

    var sandboxPath = this._generateSandboxPath(validatedExt);

    try {
      fs.writeFileSync(sandboxPath, content, 'utf8');

      // 注册 TTL 清理
      this._scheduleCleanup(sandboxPath);

      var byteLen = Buffer.byteLength(content, 'utf8');
      console.log('[FileBroker] writeContent: ' + sandboxPath + ' (' + content.length + ' chars, ' + byteLen + ' bytes)');

      return {
        sandboxPath,
        originalFilename: path.basename(sandboxPath),
        extension: validatedExt,
        size: byteLen,
        metadata: metadata || {},
      };
    } catch (err) {
      throw new Error('文件写入失败: ' + err.message);
    }
  }

  /**
   * 从沙箱读取文件内容
   *
   * @param {string} sandboxPath — 沙箱内的文件路径（相对或绝对）
   * @returns {string} 文件内容
   */
  readContent(sandboxPath) {
    var absolutePath = this._resolveSandboxPath(sandboxPath);
    this._validateSandboxPath(absolutePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error('文件不存在: ' + sandboxPath);
    }

    return fs.readFileSync(absolutePath, 'utf8');
  }

  /**
   * 构建给 Claude 的上下文消息（告知 Claude 用户发送了文件）
   *
   * 上下文消息会注入到对话中，让 Claude 知道：
   * 1. 用户发送了什么文件
   * 2. 文件在沙箱中的位置
   * 3. Claude 可以用 Read 工具读取
   *
   * @param {FileEntry} fileEntry — 文件入口信息
   * @returns {string} 上下文消息文本
   */
  buildFileContextMessage(fileEntry) {
    var lines = [
      '[系统消息] 用户发送了一个文件，已保存至沙箱：',
      '- 文件路径: ' + fileEntry.sandboxPath,
    ];
    if (fileEntry.originalFilename) {
      lines.push('- 原始文件名: ' + fileEntry.originalFilename);
    }
    if (fileEntry.size != null) {
      var sizeStr;
      if (fileEntry.size > 1024 * 1024) {
        sizeStr = (fileEntry.size / 1024 / 1024).toFixed(2) + ' MB';
      } else if (fileEntry.size > 1024) {
        sizeStr = (fileEntry.size / 1024).toFixed(1) + ' KB';
      } else {
        sizeStr = fileEntry.size + ' bytes';
      }
      lines.push('- 文件大小: ' + sizeStr);
    }
    lines.push('你可以使用 Read 工具读取此文件的内容。');
    return lines.join('\n');
  }

  /**
   * 从 Claude 返回文本中解析 [FILE_OUTPUT] 协议块
   *
   * 协议格式：
   *   [FILE_OUTPUT:filename.json]
   *   文件内容（多行）
   *   [/FILE_OUTPUT]
   *
   * 安全：
   * - 只在 allowedExtensions 白名单内的扩展名才被接受
   * - FILE_OUTPUT 块外文本保留为 cleanText
   *
   * @param {string} claudeText — Claude 返回的完整文本
   * @returns {{ cleanText: string, files: Array<{ filename: string, extension: string, content: string }> }}
   */
  parseFileOutputs(claudeText) {
    if (!claudeText) return { cleanText: '', files: [] };

    var files = [];
    // 匹配 [FILE_OUTPUT:名称]\n  ... \n[/FILE_OUTPUT]，支持多行内容，兼容 CRLF
    var fileBlockRegex = /\[FILE_OUTPUT:([^\]]+)\](?:\r?\n)([\s\S]*?)(?:\r?\n)\[\/FILE_OUTPUT\]/g;

    var cleanText = claudeText;
    var match;

    while ((match = fileBlockRegex.exec(claudeText)) !== null) {
      var filename = match[1].trim();
      var content = match[2];
      var extension = this._extractExtension(filename);

      if (!extension) {
        console.warn('[FileBroker] parseFileOutputs: 无法识别扩展名: ' + filename + '，跳过');
        continue;
      }

      // 验证扩展名是否在白名单内
      try {
        this._validateExtension(extension);
      } catch (e) {
        console.warn('[FileBroker] parseFileOutputs: ' + e.message + '，跳过文件 ' + filename);
        continue;
      }

      files.push({ filename, extension, content });
    }

    // 从文本中移除所有 FILE_OUTPUT 块，留下干净的对话文本
    cleanText = cleanText.replace(/\[FILE_OUTPUT:[^\]]+\](?:\r?\n)[\s\S]*?(?:\r?\n)\[\/FILE_OUTPUT\](?:\r?\n)?/g, '');
    cleanText = cleanText.trim();

    if (files.length > 0) {
      console.log('[FileBroker] parseFileOutputs: 提取到 ' + files.length + ' 个文件: ' + files.map(function(f) { return f.filename; }).join(', '));
    }

    return { cleanText, files };
  }

  /**
   * 清理所有沙箱文件（进程退出时调用）
   *
   * 安全：跳过符号链接，只删除普通文件
   */
  cleanupAll() {
    console.log('[FileBroker] 清理所有沙箱文件...');

    // 清除所有 TTL 定时器
    for (var _i = 0, _keys = Array.from(this._ttlTimers.keys()), _len = _keys.length; _i < _len; _i++) {
      var k = _keys[_i];
      clearTimeout(this._ttlTimers.get(k));
    }
    this._ttlTimers.clear();

    // 删除沙箱目录下所有普通文件
    if (fs.existsSync(this.sandboxDir)) {
      try {
        var entries = fs.readdirSync(this.sandboxDir);
        for (var i = 0; i < entries.length; i++) {
          var fullPath = path.join(this.sandboxDir, entries[i]);
          try {
            var stat = fs.lstatSync(fullPath);
            if (stat.isSymbolicLink()) {
              console.warn('[FileBroker] cleanupAll: 跳过符号链接 ' + fullPath);
              continue;
            }
            if (stat.isFile()) {
              fs.unlinkSync(fullPath);
              console.log('[FileBroker] 已清理: ' + fullPath);
            }
          } catch (e) {
            console.warn('[FileBroker] 删除失败: ' + fullPath + ': ' + e.message);
          }
        }
      } catch (e) {
        console.warn('[FileBroker] 读取沙箱目录失败: ' + e.message);
      }
    }

    console.log('[FileBroker] 清理完成');
  }

  // ══════════════════════════════════════════════════
  //  路径安全校验
  // ══════════════════════════════════════════════════

  /**
   * 校验沙箱路径合法性（防路径遍历攻击 + 防符号链接攻击）
   *
   * 安全链（5 层）：
   *   1. 拒绝包含 '..' 的原始路径
   *   2. path.resolve() 规范化
   *   3. fs.realpathSync() 解析符号链接
   *   4. startsWith(sandboxDir) 确保在沙箱内
   *   5. 文件不存在时检查父目录 realpath
   *
   * @param {string} absolutePath — 待校验的绝对路径
   * @returns {string} 校验通过后的规范化绝对路径
   * @throws {Error} 路径越界或为符号链接
   */
  _validateSandboxPath(absolutePath) {
    // 1. 拒绝包含 .. 的原始路径（防止 ../ 越狱）
    if (absolutePath.indexOf('..') !== -1) {
      throw new Error('路径遍历攻击被拦截: ' + absolutePath);
    }

    // 2. resolve 规范化
    var resolved = path.resolve(absolutePath);

    // 3. 再次检查 resolve 后的路径
    if (resolved.indexOf('..') !== -1) {
      throw new Error('路径遍历攻击被拦截 (resolved): ' + absolutePath);
    }

    // 3.5 提前检查沙箱边界（在 realpath 之前，避免 ENOENT 掩盖越界）
    var normalizedSandbox = path.resolve(this.sandboxDir);
    if (resolved.indexOf(normalizedSandbox + path.sep) !== 0 && resolved !== normalizedSandbox) {
      throw new Error('沙箱越界: ' + resolved + ' 不在 ' + normalizedSandbox + ' 内');
    }

    // 4. realpath 解析符号链接（防符号链接攻击）
    var realPath;
    try {
      realPath = fs.realpathSync(resolved);
    } catch (e) {
      if (e.code === 'ENOENT') {
        // 文件不存在时回退到 resolved 路径（允许创建新文件）
        // 但需要检查父目录的 realpath
        var parentDir = path.dirname(resolved);
        var realParent;
        try {
          realParent = fs.realpathSync(parentDir);
        } catch (pe) {
          throw new Error('沙箱父目录不可访问: ' + parentDir);
        }
        realPath = path.join(realParent, path.basename(resolved));
      } else {
        throw new Error('无法解析路径: ' + absolutePath + ': ' + e.message);
      }
    }

    // 5. 确保在沙箱内（二次验证，realpath 后再次确认）
    if (realPath.indexOf(normalizedSandbox + path.sep) !== 0 && realPath !== normalizedSandbox) {
      throw new Error('沙箱越界 (realpath): ' + realPath + ' 不在 ' + normalizedSandbox + ' 内');
    }

    return realPath;
  }

  /**
   * 将相对或绝对路径解析为沙箱内的绝对路径
   */
  _resolveSandboxPath(sandboxPath) {
    if (path.isAbsolute(sandboxPath)) {
      return sandboxPath;
    }
    return path.join(this.sandboxDir, sandboxPath);
  }

  // ══════════════════════════════════════════════════
  //  文件命名安全
  // ══════════════════════════════════════════════════

  /**
   * 生成沙箱内的随机文件路径（UUID 命名）
   *
   * 安全保证：文件名使用 crypto.randomUUID()，用户不可控
   *
   * @param {string} extension — 文件扩展名（含点，如 '.json'）
   * @returns {string} 完整沙箱路径
   */
  _generateSandboxPath(extension) {
    var uuid = crypto.randomUUID();
    var filename = uuid + extension;
    return path.join(this.sandboxDir, filename);
  }

  /**
   * 校验扩展名是否在输出白名单内
   *
   * @param {string} extension — 扩展名（含点，如 '.json'）
   * @returns {string} 规范化扩展名（小写）
   * @throws {Error} 扩展名不在白名单
   */
  _validateExtension(extension) {
    if (!extension || typeof extension !== 'string') {
      throw new Error('扩展名不能为空');
    }

    if (extension.charAt(0) !== '.') {
      extension = '.' + extension;
    }

    var normalExt = extension.toLowerCase();

    if (this.allowedExtensions.indexOf(normalExt) === -1) {
      throw new Error('扩展名 "' + normalExt + '" 不在白名单内。允许的扩展名: ' + this.allowedExtensions.join(', '));
    }

    return normalExt;
  }

  /**
   * 从文件名提取扩展名
   */
  _extractExtension(filename) {
    if (!filename) return '';
    var ext = path.extname(filename);
    return ext ? ext.toLowerCase() : '';
  }

  // ══════════════════════════════════════════════════
  //  TTL 自动清理
  // ══════════════════════════════════════════════════

  /**
   * 安排文件在 TTL 后自动删除
   */
  _scheduleCleanup(absolutePath) {
    // 取消已有的定时器
    if (this._ttlTimers.has(absolutePath)) {
      clearTimeout(this._ttlTimers.get(absolutePath));
    }

    var self = this;
    var timer = setTimeout(function() {
      try {
        if (fs.existsSync(absolutePath)) {
          fs.unlinkSync(absolutePath);
          console.log('[FileBroker] TTL 清理: ' + absolutePath);
        }
      } catch (e) {
        console.warn('[FileBroker] TTL 清理失败: ' + absolutePath + ': ' + e.message);
      }
      self._ttlTimers.delete(absolutePath);
    }, this.fileTtlMs);

    this._ttlTimers.set(absolutePath, timer);
  }

  // ══════════════════════════════════════════════════
  //  AES-256-CBC 解密（WeCom 文件回调）
  // ══════════════════════════════════════════════════

  /**
   * 解密 WeCom 智能机器人回调中的加密文件
   *
   * 协议：
   * - 算法：AES-256-CBC
   * - Key：aeskey 经 base64 解码（32 字节）
   * - IV：Key 的前 16 字节
   * - 填充：PKCS#7（去除尾部填充字节）
   *
   * @param {Buffer} encryptedData — 下载的加密数据
   * @param {string} aeskeyBase64 — WeCom 回调中的 aeskey 字段（base64 编码）
   * @returns {Buffer} 解密后的明文数据
   */
  _decryptAESFile(encryptedData, aeskeyBase64) {
    // 1. 解码 AES Key（base64 → 32 字节 Buffer）
    var keyBytes = Buffer.from(aeskeyBase64, 'base64');
    if (keyBytes.length !== 32) {
      throw new Error('AES key 长度异常: ' + keyBytes.length + ' bytes (期望 32)');
    }

    // 2. IV 取 key 前 16 字节（WeCom 协议规定）
    var iv = keyBytes.slice(0, 16);

    // 3. AES-256-CBC 解密
    var decipher = crypto.createDecipheriv('aes-256-cbc', keyBytes, iv);
    decipher.setAutoPadding(false); // 手动处理 PKCS#7

    var decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ]);

    // 4. 去除 PKCS#7 填充（最后一个字节的值 = 填充字节数）
    var padLength = decrypted[decrypted.length - 1];
    if (padLength > 0 && padLength <= 32) {
      // 验证所有填充字节是否一致
      var valid = true;
      for (var i = decrypted.length - padLength; i < decrypted.length; i++) {
        if (decrypted[i] !== padLength) { valid = false; break; }
      }
      if (valid) {
        decrypted = decrypted.slice(0, decrypted.length - padLength);
      }
    }

    return decrypted;
  }

  // ══════════════════════════════════════════════════
  //  HTTP 下载（零依赖，使用 Node.js 内置模块）
  // ══════════════════════════════════════════════════

  /**
   * HTTP/HTTPS 下载文件
   *
   * 安全：
   * - 大小限制（防止内存耗尽）
   * - 超时限制（30s）
   * - 自动跟随重定向
   *
   * @param {string} url — 下载 URL
   * @returns {Promise<Buffer>} 文件内容
   */
  _httpDownload(url) {
    var self = this;
    return new Promise(function(resolve, reject) {
      var parsedUrl = new URL(url);
      var client = parsedUrl.protocol === 'https:' ? https : http;

      var options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'WeComAiBotFileBroker/1.0',
        },
      };

      var req = client.request(options, function(res) {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          self._httpDownload(res.headers.location).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + (res.statusMessage || '')));
          return;
        }

        var chunks = [];
        var totalSize = 0;

        res.on('data', function(chunk) {
          totalSize += chunk.length;
          if (totalSize > self.maxFileSize) {
            req.destroy();
            reject(new Error('响应大小超过限制 ' + self.maxFileSize + ' bytes'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', function() {
          resolve(Buffer.concat(chunks));
        });

        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(30000, function() {
        req.destroy();
        reject(new Error('下载超时 (30s)'));
      });

      req.end();
    });
  }

  /**
   * MIME 类型到扩展名的简单映射（接收场景使用）
   */
  _mimeToExtension(mime) {
    var map = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/svg+xml': '.svg',
      'application/pdf': '.pdf',
      'application/json': '.json',
      'text/csv': '.csv',
      'text/plain': '.txt',
      'text/html': '.html',
      'text/markdown': '.md',
      'application/zip': '.zip',
      'application/x-zip-compressed': '.zip',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'application/vnd.ms-powerpoint': '.ppt',
    };
    return map[mime] || '';
  }

  // ══════════════════════════════════════════════════
  //  内部工具方法
  // ══════════════════════════════════════════════════

  /**
   * 确保沙箱目录存在且安全（非符号链接）
   */
  _ensureSandboxDir() {
    if (!fs.existsSync(this.sandboxDir)) {
      fs.mkdirSync(this.sandboxDir, { recursive: true });
      console.log('[FileBroker] 创建沙箱目录:', this.sandboxDir);
    }

    // 验证沙箱目录是真实目录（非符号链接）
    try {
      var stat = fs.lstatSync(this.sandboxDir);
      if (stat.isSymbolicLink()) {
        throw new Error('沙箱目录是符号链接，拒绝使用: ' + this.sandboxDir);
      }
      var realPath = fs.realpathSync(this.sandboxDir);
      if (realPath !== path.resolve(this.sandboxDir)) {
        console.warn('[FileBroker] 沙箱目录 realpath 偏离: ' + this.sandboxDir + ' → ' + realPath);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

/**
 * @typedef {Object} FileEntry
 * @property {string} sandboxPath — 沙箱内的完整路径
 * @property {string} [originalFilename] — 原始文件名
 * @property {string} extension — 扩展名
 * @property {number} size — 文件大小（bytes）
 * @property {Object} [metadata] — 附加元数据
 */

module.exports = { FileBroker, DEFAULT_ALLOWED_EXTENSIONS, DEFAULT_FILE_TTL_MS, DEFAULT_MAX_FILE_SIZE };
