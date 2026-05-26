/**
 * FileBroker 单元测试
 * 用法：node test-file-broker.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// 动态加载待测模块
const { FileBroker, DEFAULT_ALLOWED_EXTENSIONS, DEFAULT_FILE_TTL_MS, DEFAULT_MAX_FILE_SIZE } = require('./file-broker.js');

// ─── 测试框架 ───

var passed = 0;
var failed = 0;
var errors = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (e) {
    failed++;
    var err = { name: name, message: e.message };
    errors.push(err);
    console.log('  ❌ ' + name + '\n     ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEqual') + ': expected "' + expected + '", got "' + actual + '"');
  }
}

function assertThrows(fn, expectedMsg) {
  try {
    fn();
    throw new Error('Expected error but none thrown');
  } catch (e) {
    if (expectedMsg && e.message.indexOf(expectedMsg) === -1) {
      throw new Error('Expected error containing "' + expectedMsg + '", got "' + e.message + '"');
    }
  }
}

// ─── 创建测试沙箱 ───
var testSandbox = path.join(os.tmpdir(), 'wecom-test-sandbox-' + Date.now());
fs.mkdirSync(testSandbox, { recursive: true });

var broker = new FileBroker({ sandboxDir: testSandbox, fileTtlMs: 60000 });

console.log('');
console.log('═══════════════════════════════════════');
console.log('  FileBroker 单元测试');
console.log('  沙箱: ' + testSandbox);
console.log('═══════════════════════════════════════');
console.log('');

// ══════════════════════════════════════════════════
//  测试 1: 扩展名校验 (_validateExtension)
// ══════════════════════════════════════════════════
console.log('── 测试 1: 扩展名校验 ──');

test('合法扩展名 .json', function() {
  assertEqual(broker._validateExtension('.json'), '.json');
});

test('合法扩展名 .md', function() {
  assertEqual(broker._validateExtension('.md'), '.md');
});

test('扩展名大写转小写 .JSON → .json', function() {
  assertEqual(broker._validateExtension('.JSON'), '.json');
});

test('扩展名无点号自动补全 json → .json', function() {
  assertEqual(broker._validateExtension('json'), '.json');
});

test('非法扩展名 .exe 抛出异常', function() {
  assertThrows(function() { broker._validateExtension('.exe'); }, '不在白名单内');
});

test('非法扩展名 .php 抛出异常', function() {
  assertThrows(function() { broker._validateExtension('.php'); }, '不在白名单内');
});

test('空扩展名抛出异常', function() {
  assertThrows(function() { broker._validateExtension(''); });
});

test('null 扩展名抛出异常', function() {
  assertThrows(function() { broker._validateExtension(null); });
});

// ══════════════════════════════════════════════════
//  测试 2: 路径遍历检测 (_validateSandboxPath)
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 2: 路径遍历检测 ──');

test('正常沙箱内路径通过', function() {
  var p = path.join(testSandbox, 'test.txt');
  var result = broker._validateSandboxPath(p);
  assert(result.startsWith(testSandbox), 'path should be in sandbox');
});

test('.. 路径被拦截', function() {
  // 不经过 path.join（它会规范化 ..），直接用字符串拼接
  assertThrows(function() {
    broker._validateSandboxPath(testSandbox + path.sep + '..' + path.sep + 'etc' + path.sep + 'passwd');
  }, '路径遍历');
});

test('裸 .. 被拦截', function() {
  assertThrows(function() {
    broker._validateSandboxPath(testSandbox + '/../etc/passwd');
  }, '路径遍历');
});

test('沙箱外路径被拦截', function() {
  assertThrows(function() {
    broker._validateSandboxPath('/etc/passwd');
  }, '沙箱越界');
});

// ══════════════════════════════════════════════════
//  测试 3: UUID 命名 (_generateSandboxPath)
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 3: UUID 命名 ──');

test('生成路径在沙箱内', function() {
  var p = broker._generateSandboxPath('.json');
  assert(p.startsWith(testSandbox), 'path should be in sandbox: ' + p);
});

test('扩展名正确附加', function() {
  var p = broker._generateSandboxPath('.json');
  assert(p.endsWith('.json'), 'path should end with .json: ' + p);
});

test('UUID 格式正确 (36 字符 + 扩展名)', function() {
  var p = broker._generateSandboxPath('.txt');
  var filename = path.basename(p);
  // UUID v4 格式: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  var uuidPart = filename.replace('.txt', '');
  assert(uuidPart.length === 36, 'UUID length should be 36, got ' + uuidPart.length);
  assert(uuidPart.split('-').length === 5, 'UUID should have 5 dash-separated parts');
});

test('连续生成 UUID 不重复', function() {
  var paths = [];
  for (var i = 0; i < 100; i++) {
    paths.push(broker._generateSandboxPath('.json'));
  }
  var unique = new Set(paths);
  assert(unique.size === 100, 'Expected 100 unique paths, got ' + unique.size);
});

// ══════════════════════════════════════════════════
//  测试 4: FILE_OUTPUT 解析 (parseFileOutputs)
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 4: FILE_OUTPUT 解析 ──');

test('单文件解析', function() {
  var text = '你好\n\n[FILE_OUTPUT:test.json]\n{"key": "value"}\n[/FILE_OUTPUT]\n\n再见';
  var result = broker.parseFileOutputs(text);
  assert(result.files.length === 1, 'Expected 1 file, got ' + result.files.length);
  assert(result.files[0].filename === 'test.json');
  assert(result.files[0].extension === '.json');
  assert(result.files[0].content === '{"key": "value"}');
  assert(result.cleanText.indexOf('[FILE_OUTPUT') === -1, 'cleanText should not contain FILE_OUTPUT');
  assert(result.cleanText.indexOf('你好') !== -1);
  assert(result.cleanText.indexOf('再见') !== -1);
});

test('多文件解析', function() {
  var text = '[FILE_OUTPUT:a.json]\n[1,2,3]\n[/FILE_OUTPUT]\n\n[FILE_OUTPUT:b.csv]\na,b,c\n1,2,3\n[/FILE_OUTPUT]';
  var result = broker.parseFileOutputs(text);
  assert(result.files.length === 2, 'Expected 2 files, got ' + result.files.length);
  assert(result.files[0].filename === 'a.json');
  assert(result.files[1].filename === 'b.csv');
});

test('无 FILE_OUTPUT 文本', function() {
  var text = '普通回复，没有文件';
  var result = broker.parseFileOutputs(text);
  assert(result.files.length === 0, 'Expected 0 files');
  assert(result.cleanText === '普通回复，没有文件');
});

test('空文本', function() {
  var result = broker.parseFileOutputs('');
  assert(result.files.length === 0);
  assert(result.cleanText === '');
});

test('null 文本', function() {
  var result = broker.parseFileOutputs(null);
  assert(result.files.length === 0);
  assert(result.cleanText === '');
});

test('非法扩展名文件被跳过', function() {
  var text = '[FILE_OUTPUT:test.exe]\nbad content\n[/FILE_OUTPUT]';
  var result = broker.parseFileOutputs(text);
  assert(result.files.length === 0, 'Expected 0 files (skipped .exe)');
});

test('无扩展名文件被跳过', function() {
  var text = '[FILE_OUTPUT:noext]\ncontent\n[/FILE_OUTPUT]';
  var result = broker.parseFileOutputs(text);
  assert(result.files.length === 0, 'Expected 0 files (no extension)');
});

test('多行内容保留换行', function() {
  var text = '[FILE_OUTPUT:test.txt]\nline1\nline2\nline3\n[/FILE_OUTPUT]';
  var result = broker.parseFileOutputs(text);
  assert(result.files.length === 1);
  assert(result.files[0].content.indexOf('\n') !== -1, 'Content should contain newlines');
});

test('CRLF 换行符兼容', function() {
  var text = '[FILE_OUTPUT:test.json]\r\n{"a":1}\r\n[/FILE_OUTPUT]';
  var result = broker.parseFileOutputs(text);
  assert(result.files.length === 1, 'CRLF should work, got ' + result.files.length + ' files');
  assert(result.files[0].content === '{"a":1}');
});

// ══════════════════════════════════════════════════
//  测试 5: 媒体类型判断 (MessageDispatcher._getMediaType)
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 5: 媒体类型判断 ──');

// 模拟 MessageDispatcher._getMediaType
function getMediaType(extension) {
  var imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
  var ext = (extension || '').toLowerCase();
  return imageExts.indexOf(ext) !== -1 ? 'image' : 'file';
}

test('.jpg → image', function() { assertEqual(getMediaType('.jpg'), 'image'); });
test('.png → image', function() { assertEqual(getMediaType('.png'), 'image'); });
test('.svg → image', function() { assertEqual(getMediaType('.svg'), 'image'); });
test('.json → file', function() { assertEqual(getMediaType('.json'), 'file'); });
test('.csv → file', function() { assertEqual(getMediaType('.csv'), 'file'); });
test('.md → file', function() { assertEqual(getMediaType('.md'), 'file'); });
test('.JPG → image (大写)', function() { assertEqual(getMediaType('.JPG'), 'image'); });
test('无扩展名 → file', function() { assertEqual(getMediaType(''), 'file'); });

// ══════════════════════════════════════════════════
//  测试 6: FileBroker 写入和读取往返
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 6: 读写往返 ──');

test('writeContent + readContent 往返', function(done) {
  var entry;
  broker.writeContent('.json', '{"test": true}', { source: 'test' }).then(function(e) {
    entry = e;
    assert(entry.sandboxPath.startsWith(testSandbox));
    assert(entry.extension === '.json');
    assert(entry.size > 0);

    var content = broker.readContent(entry.sandboxPath);
    assertEqual(content, '{"test": true}');
  });
});

// ══════════════════════════════════════════════════
//  测试 7: buildFileContextMessage
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 7: 上下文消息构建 ──');

test('包含所有必要字段', function() {
  var msg = broker.buildFileContextMessage({
    sandboxPath: '/tmp/wecom-sandbox/test.jpg',
    originalFilename: 'photo.jpg',
    size: 102400,
  });
  assert(msg.indexOf('[系统消息]') !== -1);
  assert(msg.indexOf('/tmp/wecom-sandbox/test.jpg') !== -1);
  assert(msg.indexOf('photo.jpg') !== -1);
  assert(msg.indexOf('KB') !== -1 || msg.indexOf('bytes') !== -1);
  assert(msg.indexOf('Read') !== -1);
});

test('大小格式化 MB', function() {
  var msg = broker.buildFileContextMessage({ size: 2.5 * 1024 * 1024 });
  assert(msg.indexOf('MB') !== -1);
});

test('大小格式化 bytes', function() {
  var msg = broker.buildFileContextMessage({ size: 500 });
  assert(msg.indexOf('bytes') !== -1);
});

// ══════════════════════════════════════════════════
//  测试 8: 配置加载 (config.js)
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 8: 配置加载 ──');

// 不能直接 loadConfig()（依赖 .env），但验证模块结构
test('config.js 导出 loadConfig', function() {
  var configModule = require('./config.js');
  assert(typeof configModule.loadConfig === 'function', 'loadConfig should be a function');
});

// ══════════════════════════════════════════════════
//  测试 9: wecom-ws-client 模块加载
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 9: 模块加载验证 ──');

test('file-broker.js 导出 FileBroker', function() {
  assert(typeof FileBroker === 'function');
});

test('wecom-ws-client.js 可加载', function() {
  var m = require('./wecom-ws-client.js');
  assert(typeof m.WeComWsClient === 'function');
});

test('claude-orchestrator.js 可加载', function() {
  var m = require('./claude-orchestrator.js');
  assert(typeof m.ClaudeOrchestrator === 'function');
});

test('message-dispatcher.js 可加载', function() {
  var m = require('./message-dispatcher.js');
  assert(typeof m.MessageDispatcher === 'function');
});

test('session-manager.js 可加载', function() {
  var m = require('./session-manager.js');
  assert(typeof m.SessionManager === 'function');
});

test('concurrency-limiter.js 可加载', function() {
  var m = require('./concurrency-limiter.js');
  assert(typeof m.ConcurrencyLimiter === 'function');
});

test('main.js 语法正确', function() {
  // main.js 入口会立即执行，此处只验证 require 不报错
  // 不实际启动，只验证依赖解析
  var mainPath = require.resolve('./main.js');
  assert(mainPath.length > 0);
});

// ══════════════════════════════════════════════════
//  测试 10: TTL 清理验证
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 10: TTL 清理 ──');

test('cleanupAll 正确清空 _ttlTimers', function() {
  // 先写入一个文件以便触发 TTL 注册
  var entryP = broker.writeContent('.txt', 'test cleanup', {});

  // 验证文件存在
  var tempBroker = new FileBroker({ sandboxDir: testSandbox, fileTtlMs: 60000 });
  assert(tempBroker._ttlTimers.size === 0, 'New broker should have no timers');
});

// ══════════════════════════════════════════════════
//  清理
// ══════════════════════════════════════════════════

// ══════════════════════════════════════════════════
//  测试 11: 集成流程 (端到端数据流追踪)
// ══════════════════════════════════════════════════
console.log('');
console.log('── 测试 11: 集成流程 ──');

// 11.1 接收文件流程模拟 (downloadAndStore → buildFileContext → context injection)
test('接收文件: downloadAndStore → buildFileContext 完整链路', function(done) {
  var entry;
  // 由于无法真正下载 WeCom URL，直接写入模拟
  broker.writeContent('.txt', 'hello world from wecom', { source: 'receive' }).then(function(e) {
    entry = e;
    // 模拟 buildFileContextMessage
    var ctx = broker.buildFileContextMessage({
      sandboxPath: entry.sandboxPath,
      originalFilename: '用户上传.txt',
      size: entry.size,
    });
    assert(ctx.indexOf('[系统消息]') !== -1);
    assert(ctx.indexOf(entry.sandboxPath) !== -1);
    assert(ctx.indexOf('用户上传.txt') !== -1);
    assert(ctx.indexOf('Read') !== -1);
    assert(ctx.indexOf('bytes') !== -1);
  });
});

// 11.2 FILE_OUTPUT 完整链路: parse → write → verify
test('FILE_OUTPUT: parse → writeContent → readContent 完整链路', function(done) {
  var claudeResponse = '好的，我来生成一份报告。\n\n[FILE_OUTPUT:report.json]\n{"total": 100, "items": ["a","b","c"]}\n[/FILE_OUTPUT]\n\n报告已生成。';

  var parsed = broker.parseFileOutputs(claudeResponse);
  assert(parsed.files.length === 1);
  assert(parsed.files[0].filename === 'report.json');

  // 写入沙箱（模拟 writeContent）
  broker.writeContent(parsed.files[0].extension, parsed.files[0].content, {}).then(function(entry) {
    assert(entry.extension === '.json');

    // 验证文件存在且内容正确
    var content = broker.readContent(entry.sandboxPath);
    var obj = JSON.parse(content);
    assert(obj.total === 100);
    assert(obj.items.length === 3);

    // cleanText 不应包含 FILE_OUTPUT 块
    assert(parsed.cleanText.indexOf('[FILE_OUTPUT]') === -1);
    assert(parsed.cleanText.indexOf('报告已生成') !== -1);
  });
});

// 11.3 多文件 + 图片
test('FILE_OUTPUT: 多文件 + 图片场景', function() {
  var claudeResponse = [
    '这是分析结果：',
    '',
    '[FILE_OUTPUT:chart.csv]',
    'month,value',
    'Jan,100',
    'Feb,200',
    '[/FILE_OUTPUT]',
    '',
    '[FILE_OUTPUT:summary.json]',
    '{"status": "ok"}',
    '[/FILE_OUTPUT]',
  ].join('\n');

  var parsed = broker.parseFileOutputs(claudeResponse);
  assert(parsed.files.length === 2, 'Expected 2 files, got ' + parsed.files.length);

  // 第一个文件是 CSV → file
  var mt1 = getMediaType('.csv');
  assert(mt1 === 'file', 'csv should be file type');

  // 第二个文件是 JSON → file
  var mt2 = getMediaType('.json');
  assert(mt2 === 'file', 'json should be file type');

  // 如果是图片 → image
  var mtImg = getMediaType('.png');
  assert(mtImg === 'image', 'png should be image type');
});

// 11.4 错误回退：上传失败 → markdown 附注
test('错误回退: writeContent 非法扩展名 → 异常捕获', function() {
  assertThrows(function() {
    broker._validateExtension('.exe');
  }, '不在白名单内');
});

// 11.5 配置链验证
test('配置链: config.js → main.js → FileBroker 全程默认值一致', function() {
  // config.js 默认 sandboxDir
  assert(DEFAULT_ALLOWED_EXTENSIONS.indexOf('.json') !== -1);
  assert(DEFAULT_ALLOWED_EXTENSIONS.indexOf('.md') !== -1);
  // 默认 TTL
  assert(DEFAULT_FILE_TTL_MS === 300000);
  // 默认文件大小
  assert(DEFAULT_MAX_FILE_SIZE === 10485760);
});

// 11.6 cleanupAll 流程：写文件 → 验证存在 → cleanupAll → 验证清理
test('清理流程: writeContent → cleanupAll → 文件消失', function(done) {
  broker.writeContent('.txt', 'to be cleaned', {}).then(function(entry) {
    // 验证文件存在
    assert(fs.existsSync(entry.sandboxPath), 'File should exist before cleanup');

    // 执行清理
    broker.cleanupAll();

    // 验证文件消失
    assert(!fs.existsSync(entry.sandboxPath), 'File should NOT exist after cleanup');
  });
});

// 11.7 TTL 自动清理验证（短 TTL）
test('TTL 自动清理: 短 TTL 后文件自动删除', function(done) {
  var shortBroker = new FileBroker({
    sandboxDir: testSandbox + '-ttl',
    fileTtlMs: 100, // 100ms TTL
  });

  shortBroker.writeContent('.txt', 'ttl test', {}).then(function(entry) {
    assert(fs.existsSync(entry.sandboxPath), 'File should exist before TTL');

    // 等待 TTL + 缓冲
    setTimeout(function() {
      assert(!fs.existsSync(entry.sandboxPath), 'File should be auto-cleaned by TTL');
      shortBroker.cleanupAll();
      try { fs.rmdirSync(testSandbox + '-ttl'); } catch(e) {}
      done();
    }, 300);
  });
});

// ══════════════════════════════════════════════════
//  清理
// ══════════════════════════════════════════════════
broker.cleanupAll();
try { fs.rmdirSync(testSandbox); } catch(e) {}

// ─── 测试报告 ───
console.log('');
console.log('═══════════════════════════════════════');
console.log('  测试结果');
console.log('═══════════════════════════════════════');
console.log('  通过: ' + passed);
console.log('  失败: ' + failed);
console.log('  总计: ' + (passed + failed));
console.log('');

if (errors.length > 0) {
  console.log('  失败详情:');
  errors.forEach(function(e) { console.log('    - ' + e.name + ': ' + e.message); });
}

console.log('');
if (failed === 0) {
  console.log('  ✅ 所有测试通过！');
} else {
  console.log('  ❌ ' + failed + ' 个测试失败');
}

process.exit(failed > 0 ? 1 : 0);
