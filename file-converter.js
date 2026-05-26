/**
 * FileConverter — 办公文档格式转换模块
 *
 * 支持的转换：
 *   .docx → .md    (mammoth — 零原生依赖)
 *   .xlsx → .csv   (SheetJS xlsx Community Edition)
 *   .pptx → .txt   (ZIP 解析 + XML 文本提取)
 *   .pdf  → 不转换 (Claude Read 原生支持 PDF)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const CONVERTIBLE_EXTENSIONS = {
  '.docx': { label: 'Word 文档', targetExt: '.md', format: 'markdown' },
  '.xlsx': { label: 'Excel 表格', targetExt: '.csv', format: 'csv' },
  '.pptx': { label: 'PPT 演示',  targetExt: '.txt', format: 'text' },
};

const NATIVE_SUPPORTED = ['.pdf'];

class FileConverter {
  constructor(options) {
    if (!options) options = {};
    this.enabled = options.enabled !== false;
    this.maxConvertSize = options.maxConvertSize || 50 * 1024 * 1024;
  }

  isConvertible(extension) {
    if (!this.enabled) return false;
    var ext = (extension || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(CONVERTIBLE_EXTENSIONS, ext);
  }

  isNativeSupported(extension) {
    return NATIVE_SUPPORTED.indexOf((extension || '').toLowerCase()) !== -1;
  }

  async convert(sourcePath, extension) {
    if (!this.enabled) return null;

    var ext = (extension || '').toLowerCase();
    var meta = CONVERTIBLE_EXTENSIONS[ext];
    if (!meta) return null;

    try {
      var stat = fs.statSync(sourcePath);
      if (stat.size > this.maxConvertSize) {
        console.log('[FileConverter] 文件过大，跳过转换');
        return null;
      }
    } catch (e) {
      return null;
    }

    console.log('[FileConverter] 开始转换 ' + meta.label + ': ' + sourcePath);
    var startTime = Date.now();

    try {
      var text;
      switch (ext) {
        case '.docx': text = await this._convertDocx(sourcePath); break;
        case '.xlsx': text = await this._convertXlsx(sourcePath); break;
        case '.pptx': text = this._convertPptx(sourcePath); break;
        default: return null;
      }

      if (!text || !text.trim()) {
        console.log('[FileConverter] 转换结果为空');
        return null;
      }

      var dir = path.dirname(sourcePath);
      var baseName = path.basename(sourcePath, ext);
      var convertedPath = path.join(dir, baseName + '.converted' + meta.targetExt);

      fs.writeFileSync(convertedPath, text, 'utf8');

      var elapsed = Date.now() - startTime;
      console.log('[FileConverter] ' + meta.label + ' 转换完成: ' + text.length + ' chars, ' + elapsed + 'ms -> ' + convertedPath);

      return {
        convertedPath: convertedPath,
        format: meta.format,
        text: text,
        originalExtension: ext,
        targetExtension: meta.targetExt,
      };
    } catch (e) {
      console.error('[FileConverter] 转换失败: ' + e.message);
      return null;
    }
  }

  // ── .docx → markdown ──

  async _convertDocx(sourcePath) {
    var mammoth = require('mammoth');
    var buffer = fs.readFileSync(sourcePath);
    var result = await mammoth.convertToMarkdown({ buffer: buffer });
    if (result.messages && result.messages.length > 0) {
      result.messages.forEach(function(m) {
        console.log('[FileConverter] mammoth:', m.type, m.message);
      });
    }
    return result.value || '';
  }

  // ── .xlsx → csv ──

  async _convertXlsx(sourcePath) {
    var XLSX = require('xlsx');
    var workbook = XLSX.readFile(sourcePath);
    var sheetNames = workbook.SheetNames;

    var allParts = [];
    for (var i = 0; i < sheetNames.length; i++) {
      var name = sheetNames[i];
      var csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false });
      if (sheetNames.length > 1) {
        allParts.push('## Sheet: ' + name + '\n\n' + csv);
      } else {
        allParts.push(csv);
      }
    }
    return allParts.join('\n\n');
  }

  // ── .pptx → text (ZIP 解析 + XML 文本提取) ──

  _convertPptx(sourcePath) {
    var buffer = fs.readFileSync(sourcePath);
    var slideEntries = this._extractZipEntries(buffer, /^ppt\/slides\/slide\d+\.xml$/i);

    if (slideEntries.length === 0) {
      throw new Error('PPTX 中未找到幻灯片');
    }

    var parts = [];
    for (var i = 0; i < slideEntries.length; i++) {
      var text = this._extractPptxXmlText(slideEntries[i].data.toString('utf8')).trim();
      if (text) {
        parts.push('--- Slide ' + (i + 1) + ' ---\n' + text);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * ZIP 解析：读取匹配指定模式的条目内容
   * 支持 Store (0) 和 Deflate (8) 两种压缩方式
   * @returns {Array<{name:string, data:Buffer}>}
   */
  _extractZipEntries(buffer, namePattern) {
    var results = [];

    // 1. 找到 EOCD signature 0x06054b50 (从末尾往前搜索)
    var eocdOffset = buffer.length - 22;
    while (eocdOffset > 0 && buffer.readUInt32LE(eocdOffset) !== 0x06054b50) {
      eocdOffset--;
    }
    if (eocdOffset <= 0) return results;

    var cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    var cdCount = buffer.readUInt16LE(eocdOffset + 8);

    // 2. 遍历 Central Directory，收集匹配条目
    var entries = [];
    var pos = cdOffset;
    for (var i = 0; i < cdCount; i++) {
      if (buffer.readUInt32LE(pos) !== 0x02014b50) break;

      var compMethod = buffer.readUInt16LE(pos + 10);
      var compSize = buffer.readUInt32LE(pos + 20);
      var localOffset = buffer.readUInt32LE(pos + 42);
      var nameLen = buffer.readUInt16LE(pos + 28);
      var extraLen = buffer.readUInt16LE(pos + 30);
      var commentLen = buffer.readUInt16LE(pos + 32);
      var name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);

      if (namePattern.test(name)) {
        entries.push({
          name: name,
          method: compMethod,
          size: compSize,
          offset: localOffset,
          nameLen: nameLen,
          extraLen: extraLen,
        });
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }

    if (entries.length === 0) return results;

    // 3. 读取每个条目数据 (从 Local File Header)
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var lhPos = e.offset;
      if (buffer.readUInt32LE(lhPos) !== 0x04034b50) continue;

      var lhNameLen = buffer.readUInt16LE(lhPos + 26);
      var lhExtraLen = buffer.readUInt16LE(lhPos + 28);
      var dataStart = lhPos + 30 + lhNameLen + lhExtraLen;

      try {
        if (e.method === 0) {
          // Store — 无压缩，直接读取
          results.push({ name: e.name, data: buffer.slice(dataStart, dataStart + e.size) });
        } else if (e.method === 8) {
          // Deflate
          var raw = buffer.slice(dataStart, dataStart + e.size);
          results.push({ name: e.name, data: zlib.inflateRawSync(raw) });
        }
      } catch (err) {
        console.log('[FileConverter] ZIP entry "' + e.name + '" 解压失败: ' + err.message);
      }
    }

    return results;
  }

  /**
   * 从 PPTX 幻灯片 XML 中提取 <a:t> 元素文本
   */
  _extractPptxXmlText(xml) {
    var texts = [];
    var regex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    var match;
    while ((match = regex.exec(xml)) !== null) {
      var t = match[1].trim();
      if (t) texts.push(t);
    }
    return texts.join(' ');
  }
}

module.exports = { FileConverter, CONVERTIBLE_EXTENSIONS, NATIVE_SUPPORTED };
