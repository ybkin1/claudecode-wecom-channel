/**
 * FileBroker — 企业微信文件安全读写中间层
 *
 * 安全隔离 Claude 子进程的只读环境与文件写入能力：
 * - 所有文件写入沙箱目录（UUID 命名，扩展名白名单，TTL 自动清理）
 * - 路径遍历攻击自动拦截
 * - 符号链接攻击自动拦截
 * - Office 文档自动转换（.docx→.md / .xlsx→.csv / .pptx→.txt）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { FileConverter } = require('./file-converter.js');

const DEFAULT_ALLOWED_EXTENSIONS = [
  '.md', '.txt', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.html', '.css', '.js', '.ts', '.py', '.sh', '.ps1',
  '.log', '.rst', '.cfg', '.ini', '.toml',
  '.docx', '.xlsx', '.pptx', '.pdf', '.doc', '.xls', '.ppt',
];

const DEFAULT_FILE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

class FileBroker {
  constructor(options) {
    if (!options) options = {};
    this.sandboxDir = options.sandboxDir || '/tmp/wecom-sandbox';
    this.allowedExtensions = options.allowedExtensions || DEFAULT_ALLOWED_EXTENSIONS;
    this.fileTtlMs = options.fileTtlMs || DEFAULT_FILE_TTL_MS;
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;

    this._ensureSandboxDir();
    this._ttlTimers = new Map();
    this.converter = new FileConverter(options.converterOptions || {});

    console.log('[FileBroker] 沙箱目录:', this.sandboxDir);
    console.log('[FileBroker] 输出扩展名白名单:', this.allowedExtensions.join(', '));
    console.log('[FileBroker] TTL:', this.fileTtlMs, 'ms, 最大文件大小:', (this.maxFileSize / 1024 / 1024).toFixed(0), 'MB');
    console.log('[FileBroker] 文档转换:', this.converter.enabled ? '已启用' : '已禁用');
  }

  getUserDir(userId) {
    var safeName = this._sanitizeUserId(userId);
    var userDir = path.join(this.sandboxDir, safeName);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    return userDir;
  }

  async downloadAndStore(url, originalFilename, mimeHint, aeskey, userId) {
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

    var sandboxPath = this._generateSandboxPath(extension, userId);
    var sandboxDir = path.dirname(sandboxPath);
    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true });
    }

    try {
      var content = await this._httpDownload(url);

      if (aeskey) {
        content = this._decryptAESFile(content, aeskey);
        console.log('[FileBroker] downloadAndStore: AES 解密完成, ' + content.length + ' bytes');
      }

      if (content.length > this.maxFileSize) {
        throw new Error('文件大小 ' + content.length + ' bytes 超过限制 ' + this.maxFileSize + ' bytes');
      }

      fs.writeFileSync(sandboxPath, content);
      this._scheduleCleanup(sandboxPath);
      console.log('[FileBroker] downloadAndStore: ' + sandboxPath + ' (' + content.length + ' bytes)');

      // ── 魔数检测：WeCom 不返回文件名，通过内容推断真实格式 ──
      var detectedExt = this._detectFileTypeByContent(content);
      if (detectedExt && detectedExt !== extension) {
        console.log("[FileBroker] 魔数检测: " + extension + " -> " + detectedExt + " (内容签名匹配)");
        var newPath = sandboxPath.replace(/\.[^.]+$/, detectedExt);
        try {
          fs.renameSync(sandboxPath, newPath);
          // 同步 TTL 定时器
          if (this._ttlTimers.has(sandboxPath)) {
            var timer = this._ttlTimers.get(sandboxPath);
            this._ttlTimers.delete(sandboxPath);
            this._ttlTimers.set(newPath, timer);
          }
          sandboxPath = newPath;
          extension = detectedExt;
          console.log("[FileBroker] 文件已重命名: " + sandboxPath);
        } catch (renameErr) {
          console.warn("[FileBroker] 重命名失败: " + renameErr.message);
        }
      }

      // Office 文档自动转换
      var convertResult = null;
      if (this.converter.isConvertible(extension)) {
        try {
          convertResult = await this.converter.convert(sandboxPath, extension);
          if (convertResult && convertResult.convertedPath) {
            this._scheduleCleanup(convertResult.convertedPath);
          }
        } catch (convErr) {
          console.warn('[FileBroker] 转换失败（不影响原始文件）: ' + convErr.message);
        }
      }

      return {
        sandboxPath,
        originalFilename,
        extension,
        size: content.length,
        converted: convertResult,
        isNativeReadable: this.converter.isNativeSupported(extension),
      };
    } catch (err) {
      try { fs.unlinkSync(sandboxPath); } catch (e) { /* ignore */ }
      throw new Error('文件下载/存储失败: ' + err.message);
    }
  }

  buildFileContextMessage(fileEntry) {
    var lines = [];

    // 如果有转换结果，直接注入文本内容
    if (fileEntry.converted && fileEntry.converted.text) {
      var convertMeta = {};
      convertMeta['.docx'] = 'Word 文档';
      convertMeta['.xlsx'] = 'Excel 表格';
      convertMeta['.pptx'] = 'PPT 演示';
      var label = convertMeta[fileEntry.extension] || '文档';
      var convertedText = fileEntry.converted.text;

      lines.push('[系统消息] 用户发送了一个' + label + '（' + (fileEntry.originalFilename || '文件') + '），内容已自动提取如下：');
      lines.push('');
      lines.push('--- 文件内容开始 ---');

      var maxConvertedChars = 50000;
      if (convertedText.length > maxConvertedChars) {
        convertedText = convertedText.substring(0, maxConvertedChars)
          + '\n\n... (内容过长，已截断，完整文件约 ' + (convertedText.length / 1024).toFixed(0) + 'KB)';
      }
      lines.push(convertedText);
      lines.push('--- 文件内容结束 ---');
      lines.push('');
      lines.push('原始文件路径: ' + fileEntry.sandboxPath);
      lines.push('你可以直接分析以上内容回答用户的问题。');
      return lines.join('\n');
    }

    // 图片、PDF 等原生可读格式 — 让 Claude 自己 Read
    lines.push('[系统消息] 用户发送了一个文件，已保存至沙箱：');
    lines.push('- 文件路径: ' + fileEntry.sandboxPath);
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
    if (fileEntry.converted && fileEntry.converted.convertedPath) {
      lines.push('- 已转换副本: ' + fileEntry.converted.convertedPath + ' (可直接 Read)');
    }
    lines.push('你可以使用 Read 工具读取此文件的内容。');
    return lines.join('\n');
  }

  async writeContent(extension, content, metadata, userId) {
    var validatedExt = this._validateExtension(extension);
    var sandboxPath = this._generateSandboxPath(validatedExt, userId);
    var sandboxDir = path.dirname(sandboxPath);
    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true });
    }
    try {
      fs.writeFileSync(sandboxPath, content, 'utf8');
      this._scheduleCleanup(sandboxPath);
      var byteLen = Buffer.byteLength(content, 'utf8');
      console.log('[FileBroker] writeContent: ' + sandboxPath + ' (' + content.length + ' chars)');
      return { sandboxPath, originalFilename: path.basename(sandboxPath), extension: validatedExt, size: byteLen, metadata: metadata || {} };
    } catch (err) {
      throw new Error('文件写入失败: ' + err.message);
    }
  }

  readContent(sandboxPath) {
    var absolutePath = this._resolveSandboxPath(sandboxPath);
    this._validateSandboxPath(absolutePath);
    if (!fs.existsSync(absolutePath)) throw new Error('文件不存在: ' + sandboxPath);
    return fs.readFileSync(absolutePath, 'utf8');
  }

  parseFileOutputs(claudeText) {
    if (!claudeText) return { cleanText: '', files: [] };
    var files = [];
    var fileBlockRegex = /\[FILE_OUTPUT:([^\]]+)\](?:\r?\n)([\s\S]*?)(?:\r?\n)\[\/FILE_OUTPUT\]/g;
    var match;
    while ((match = fileBlockRegex.exec(claudeText)) !== null) {
      var filename = match[1].trim();
      var content = match[2];
      var extension = this._extractExtension(filename);
      if (!extension) continue;
      try { this._validateExtension(extension); } catch (e) { continue; }
      files.push({ filename, extension, content });
    }
    var cleanText = claudeText.replace(/\[FILE_OUTPUT:[^\]]+\](?:\r?\n)[\s\S]*?(?:\r?\n)\[\/FILE_OUTPUT\](?:\r?\n)?/g, '').trim();
    return { cleanText, files };
  }

  cleanupAll() {
    console.log('[FileBroker] 清理所有沙箱文件...');
    var keys = Array.from(this._ttlTimers.keys());
    for (var i = 0; i < keys.length; i++) clearTimeout(this._ttlTimers.get(keys[i]));
    this._ttlTimers.clear();
    this._cleanupDir(this.sandboxDir);
    console.log('[FileBroker] 清理完成');
  }

  _cleanupDir(dir) {
    if (!fs.existsSync(dir)) return;
    try {
      var entries = fs.readdirSync(dir);
      for (var i = 0; i < entries.length; i++) {
        var fullPath = path.join(dir, entries[i]);
        try {
          var stat = fs.lstatSync(fullPath);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) { this._cleanupDir(fullPath); try { fs.rmdirSync(fullPath); } catch (e) {} }
          else if (stat.isFile()) { fs.unlinkSync(fullPath); }
        } catch (e) {}
      }
    } catch (e) {}
  }

  _validateSandboxPath(absolutePath) {
    if (absolutePath.indexOf('..') !== -1) throw new Error('路径遍历攻击被拦截');
    var resolved = path.resolve(absolutePath);
    var normalizedSandbox = path.resolve(this.sandboxDir);
    if (resolved.indexOf(normalizedSandbox + path.sep) !== 0 && resolved !== normalizedSandbox)
      throw new Error('沙箱越界');
    var realPath;
    try { realPath = fs.realpathSync(resolved); } catch (e) {
      if (e.code === 'ENOENT') {
        var parentDir = path.dirname(resolved);
        var realParent;
        try { realParent = fs.realpathSync(parentDir); } catch (pe) { throw new Error('沙箱父目录不可访问'); }
        realPath = path.join(realParent, path.basename(resolved));
      } else { throw e; }
    }
    if (realPath.indexOf(normalizedSandbox + path.sep) !== 0 && realPath !== normalizedSandbox)
      throw new Error('沙箱越界 (realpath)');
    return realPath;
  }

  _resolveSandboxPath(sandboxPath) {
    return path.isAbsolute(sandboxPath) ? sandboxPath : path.join(this.sandboxDir, sandboxPath);
  }

  _generateSandboxPath(extension, userId) {
    var uuid = crypto.randomUUID();
    var filename = uuid + extension;
    if (userId) return path.join(this.sandboxDir, this._sanitizeUserId(userId), filename);
    return path.join(this.sandboxDir, filename);
  }

  _validateExtension(extension) {
    if (!extension || typeof extension !== 'string') throw new Error('扩展名不能为空');
    if (extension.charAt(0) !== '.') extension = '.' + extension;
    var normalExt = extension.toLowerCase();
    if (this.allowedExtensions.indexOf(normalExt) === -1) throw new Error('扩展名不在白名单内');
    return normalExt;
  }

  _extractExtension(filename) {
    if (!filename) return '';
    var ext = path.extname(filename);
    return ext ? ext.toLowerCase() : '';
  }

  _scheduleCleanup(absolutePath) {
    if (this._ttlTimers.has(absolutePath)) clearTimeout(this._ttlTimers.get(absolutePath));
    var self = this;
    var timer = setTimeout(function() {
      try { if (fs.existsSync(absolutePath)) { fs.unlinkSync(absolutePath); } } catch (e) {}
      self._ttlTimers.delete(absolutePath);
    }, this.fileTtlMs);
    this._ttlTimers.set(absolutePath, timer);
  }

  _decryptAESFile(encryptedData, aeskeyBase64) {
    var keyBytes = Buffer.from(aeskeyBase64, 'base64');
    if (keyBytes.length !== 32) throw new Error('AES key 长度异常');
    var iv = keyBytes.slice(0, 16);
    var decipher = crypto.createDecipheriv('aes-256-cbc', keyBytes, iv);
    decipher.setAutoPadding(false);
    var decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    var padLength = decrypted[decrypted.length - 1];
    if (padLength > 0 && padLength <= 32) {
      var valid = true;
      for (var i = decrypted.length - padLength; i < decrypted.length; i++) {
        if (decrypted[i] !== padLength) { valid = false; break; }
      }
      if (valid) decrypted = decrypted.slice(0, decrypted.length - padLength);
    }
    return decrypted;
  }

  _httpDownload(url) {
    var self = this;
    return new Promise(function(resolve, reject) {
      var parsedUrl = new URL(url);
      var client = parsedUrl.protocol === 'https:' ? https : http;
      var req = client.request({
        hostname: parsedUrl.hostname, port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search, method: 'GET',
        headers: { 'User-Agent': 'WeComAiBotFileBroker/1.0' },
      }, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          self._httpDownload(res.headers.location).then(resolve).catch(reject); return;
        }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        var chunks = [], totalSize = 0;
        res.on('data', function(chunk) {
          totalSize += chunk.length;
          if (totalSize > self.maxFileSize) { req.destroy(); reject(new Error('响应大小超过限制')); return; }
          chunks.push(chunk);
        });
        res.on('end', function() { resolve(Buffer.concat(chunks)); });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, function() { req.destroy(); reject(new Error('下载超时')); });
      req.end();
    });
  }

  /**
   * 通过文件内容魔数检测真实类型（WeCom 不返回文件名/MIME 的兜底方案）
   *
   * ZIP-based formats (.docx/.xlsx/.pptx)：
   *   搜索 buffer 中的 ZIP Central Directory 条目名来确定具体格式
   */
  _detectFileTypeByContent(fileBuf) {
    if (!fileBuf || fileBuf.length < 4) return null;

    // ZIP magic bytes (PK\x03\x04) — Office Open XML formats
    if (fileBuf[0] === 0x50 && fileBuf[1] === 0x4B && fileBuf[2] === 0x03 && fileBuf[3] === 0x04) {
      // 搜索 ZIP 中央目录中的特征文件名（纯 ASCII，可直接字符串匹配）
      var str = fileBuf.toString("latin1");
      if (str.indexOf("word/document.xml") !== -1) return ".docx";
      if (str.indexOf("xl/workbook.xml") !== -1) return ".xlsx";
      if (str.indexOf("ppt/presentation.xml") !== -1) return ".pptx";
      // ZIP 但不是已知 Office 格式
      return ".zip";
    }

    // PDF
    if (fileBuf[0] === 0x25 && fileBuf[1] === 0x50 && fileBuf[2] === 0x44) return ".pdf";

    // Images
    if (fileBuf[0] === 0x89 && fileBuf[1] === 0x50 && fileBuf[2] === 0x4E && fileBuf[3] === 0x47) return ".png";
    if (fileBuf[0] === 0xFF && fileBuf[1] === 0xD8 && fileBuf[2] === 0xFF) return ".jpg";
    if (fileBuf[0] === 0x47 && fileBuf[1] === 0x49 && fileBuf[2] === 0x46 && fileBuf[3] === 0x38) return ".gif";
    if (fileBuf[0] === 0x42 && fileBuf[1] === 0x4D) return ".bmp";

    // RIFF WEBP
    if (fileBuf[0] === 0x52 && fileBuf[1] === 0x49 && fileBuf[2] === 0x46 && fileBuf[3] === 0x46 &&
        fileBuf.length >= 12 && fileBuf[8] === 0x57 && fileBuf[9] === 0x45 && fileBuf[10] === 0x42 && fileBuf[11] === 0x50) return ".webp";

    // Plain text / JSON / CSV — 检查是否全部为可打印 ASCII/UTF-8
    // 跳过，避免误判（让 Claude Read 自己读 .bin）

    return null;
  }

  _mimeToExtension(mime) {
    var map = {
      'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
      'application/pdf': '.pdf', 'application/json': '.json',
      'text/csv': '.csv', 'text/plain': '.txt', 'text/html': '.html', 'text/markdown': '.md',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'application/vnd.ms-powerpoint': '.ppt',
    };
    return map[mime] || '';
  }

  _sanitizeUserId(userId) {
    if (!userId) return 'default';
    return String(userId).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64) || 'default';
  }

  _ensureSandboxDir() {
    if (!fs.existsSync(this.sandboxDir)) {
      fs.mkdirSync(this.sandboxDir, { recursive: true });
    }
    try {
      var stat = fs.lstatSync(this.sandboxDir);
      if (stat.isSymbolicLink()) throw new Error('沙箱目录是符号链接');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

module.exports = { FileBroker, DEFAULT_ALLOWED_EXTENSIONS, DEFAULT_FILE_TTL_MS, DEFAULT_MAX_FILE_SIZE };
