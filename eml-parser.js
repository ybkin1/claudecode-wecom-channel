/**
 * EML Parser — 解析 MIME 邮件，提取正文和附件
 *
 * 支持：
 * - multipart/mixed, multipart/related, multipart/alternative
 * - 嵌套 multipart
 * - Content-Transfer-Encoding: base64, quoted-printable, 7bit, 8bit
 * - Content-Disposition: attachment / inline
 */

class EmlParser {
  static parse(raw) {
    var text = typeof raw === 'string' ? raw : raw.toString('utf8');
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    var headers = {};
    var bodyOffset = EmlParser._parseHeaders(text, 0, headers);

    var result = {
      subject: headers['subject'] || '',
      from: headers['from'] || '',
      to: headers['to'] || '',
      date: headers['date'] || '',
      contentType: headers['content-type'] || 'text/plain',
      textBody: '',
      htmlBody: '',
      attachments: [],
    };

    EmlParser._parseBody(text, bodyOffset, result.contentType, result);
    return result;
  }

  /**
   * 解析头部，返回 body 的字符偏移量
   */
  static _parseHeaders(text, startOffset, headers) {
    var pos = startOffset;
    var currentKey = null;

    while (pos < text.length) {
      // 双换行 = 头部结束
      if (text.charAt(pos) === '\n') {
        pos++;
        return pos; // body 从这里开始
      }

      // 找行尾
      var lineEnd = text.indexOf('\n', pos);
      if (lineEnd === -1) lineEnd = text.length;
      var line = text.substring(pos, lineEnd);

      // 续行
      if ((line.charAt(0) === ' ' || line.charAt(0) === '\t') && currentKey) {
        headers[currentKey] += ' ' + line.trim();
        pos = lineEnd + 1;
        continue;
      }

      var colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        var key = line.substring(0, colonIdx).toLowerCase().trim();
        var value = line.substring(colonIdx + 1).trim();
        headers[key] = value;
        currentKey = key;
      }
      pos = lineEnd + 1;
    }
    return text.length;
  }

  static _parseBody(text, startOffset, contentType, result) {
    var ctLower = (contentType || '').toLowerCase();
    var boundary = EmlParser._extractParam(contentType, 'boundary');

    if (!boundary) {
      // 非 multipart — 直接当正文
      var body = text.substring(startOffset).trim();
      var encoding = ''; // 头部已在顶层传入
      if (ctLower.indexOf('text/html') !== -1) {
        result.htmlBody = body;
      } else {
        result.textBody = body;
      }
      return;
    }

    // Multipart: 按 boundary 拆分
    var boundaryDelim = '--' + boundary;
    var endBoundary = boundaryDelim + '--';
    var pos = startOffset;

    while (pos < text.length) {
      // 找下一个 boundary
      var bIdx = text.indexOf(boundaryDelim, pos);
      if (bIdx === -1) break;

      var partStart = text.indexOf('\n', bIdx);
      if (partStart === -1) break;
      partStart++; // 跳过 boundary 行

      // 检查是否为结束标记
      var afterBoundary = text.substring(bIdx, bIdx + endBoundary.length);
      if (afterBoundary === endBoundary) break;

      // 找下一个 boundary（这部分结束位置）
      var nextBIdx = text.indexOf(boundaryDelim, partStart);
      if (nextBIdx === -1) nextBIdx = text.length;
      var partText = text.substring(partStart, nextBIdx);

      // 去掉尾部多余的换行
      if (partText.charAt(partText.length - 1) === '\n') {
        partText = partText.substring(0, partText.length - 1);
      }

      // 解析 MIME 部分头部 + body
      var partHeaders = {};
      var bodyOffset = EmlParser._parseHeaders(partText, 0, partHeaders);
      var partBody = partText.substring(bodyOffset).trim();

      var partCT = partHeaders['content-type'] || 'text/plain';
      var disposition = partHeaders['content-disposition'] || '';
      var encoding = partHeaders['content-transfer-encoding'] || '7bit';
      var partCharset = EmlParser._extractParam(partCT, 'charset');
      var filename = EmlParser._extractParam(disposition, 'filename')
        || EmlParser._extractParam(partCT, 'name')
        || '';

      // 嵌套 multipart
      if (partCT.toLowerCase().indexOf('multipart/') !== -1) {
        EmlParser._parseBody(partText, bodyOffset, partCT, result);
        pos = nextBIdx;
        continue;
      }

      // 判断附件还是正文
      var isAttachment = disposition.toLowerCase().indexOf('attachment') !== -1;

      if (isAttachment && filename) {
        var decodedContent = EmlParser._decodeContent(partBody, encoding, false);
        result.attachments.push({
          filename: filename,
          contentType: partCT,
          content: decodedContent,
        });
      } else if (partCT.toLowerCase().indexOf('text/html') !== -1 && !isAttachment) {
        result.htmlBody = EmlParser._decodeContent(partBody, encoding, true).toString('utf8');
      } else if (!isAttachment) {
        result.textBody = EmlParser._decodeContent(partBody, encoding, true).toString('utf8');
      }

      pos = nextBIdx;
    }
  }

  /**
   * 解码 MIME 内容
   * @param {string} body — 原始 body 文本
   * @param {string} encoding — Content-Transfer-Encoding
   * @param {boolean} asText — 是否强制作为文本解码
   * @returns {Buffer|string}
   */
  static _decodeContent(body, encoding, asText) {
    var enc = (encoding || '').toLowerCase().trim();

    if (enc === 'base64') {
      var cleaned = body.replace(/[\s\n\r]/g, '');
      var buf = Buffer.from(cleaned, 'base64');
      if (asText) return buf.toString('utf8');
      // 探测是否为文本：>85% 可打印字符
      var printable = 0, len = Math.min(buf.length, 2000);
      for (var i = 0; i < len; i++) {
        var b = buf[i];
        if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13 || b > 127) printable++;
      }
      return (printable / len > 0.85) ? buf.toString('utf8') : buf;
    }

    if (enc === 'quoted-printable') {
      // 解码 =XX 转义
      var lines = body.split('\n');
      var qpLines = [];
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (l.charAt(l.length - 1) === '\r') l = l.substring(0, l.length - 1);
        if (l.charAt(l.length - 1) === '=') {
          // 软换行：去掉 = 并连接下一行
          qpLines.push(l.substring(0, l.length - 1));
        } else {
          qpLines.push(l + '\n');
        }
      }
      var qpText = qpLines.join('');
      // 构建字节 Buffer
      // 转为 UTF-8 字节处理 =XX (charCodeAt损坏多字节字符)
      var rawBuf = Buffer.from(qpText, "utf8");
      var bytes = [];
      var p = 0;
      while (p < rawBuf.length) {
        if (rawBuf[p] === 0x3D && p + 2 < rawBuf.length) {
          var h1 = rawBuf[p+1], h2 = rawBuf[p+2];
          if (((h1>=48&&h1<=57)||(h1>=65&&h1<=70)||(h1>=97&&h1<=102)) && ((h2>=48&&h2<=57)||(h2>=65&&h2<=70)||(h2>=97&&h2<=102))) {
            bytes.push(parseInt(String.fromCharCode(h1,h2), 16));
            p += 3;
            continue;
          }
        }
        bytes.push(rawBuf[p]);
        p++;
      }
      return Buffer.from(bytes).toString('utf8');
    }

    // 7bit / 8bit — 原样返回
    return asText ? body : Buffer.from(body, 'utf8');
  }

  static _extractBoundary(contentType) {
    return EmlParser._extractParam(contentType, 'boundary');
  }

  static _extractParam(headerValue, paramName) {
    if (!headerValue) return '';
    var lower = headerValue.toLowerCase();
    var idx = lower.indexOf(paramName.toLowerCase() + '=');
    if (idx === -1) return '';
    var start = idx + paramName.length + 1;
    var rest = headerValue.substring(start);
    var quote = rest.charAt(0) === '"';
    if (quote) {
      var endQuote = rest.indexOf('"', 1);
      return endQuote === -1 ? rest.substring(1) : rest.substring(1, endQuote);
    }
    var semi = rest.indexOf(';');
    return semi === -1 ? rest.trim() : rest.substring(0, semi).trim();
  }
}

module.exports = { EmlParser };
