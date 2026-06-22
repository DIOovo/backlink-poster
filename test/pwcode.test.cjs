/**
 * utils/pwcode 往返单测（纯逻辑，无需浏览器）。
 * 运行：npm test  （会先用 tsc 把 pwcode.ts 编译到 .tmp-test 再执行本文件）
 */
const assert = require('node:assert');
const path = require('node:path');

const pw = require(path.join(__dirname, '..', '.tmp-test', 'utils', 'pwcode.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('pwcode round-trip tests');

// 1) splitStatements：引号内分号不切分
test('splitStatements ignores semicolons inside quotes', () => {
  const stmts = pw.splitStatements("await page.locator('a;b').click(); await page.getByText('x').click();");
  assert.strictEqual(stmts.length, 2);
});

// 2) 关键回归：带 .first() 的链不能被折叠成结构化 target（否则丢 .first() → 命中多个）
test('codeToActions preserves trailing .first() as raw', () => {
  const code = "await page.getByRole('textbox', { name: 'Rich Text Editor. Editing' }).first().fill(`hi`);";
  const [a] = pw.codeToActions(code);
  assert.strictEqual(a.type, 'fill');
  assert.strictEqual(a.value, 'hi');
  assert.strictEqual(a.raw, "page.getByRole('textbox', { name: 'Rich Text Editor. Editing' }).first()");
  assert.strictEqual(a.target.value, ''); // 未被折叠成结构化 target
});

// 3) 无后缀的简单定位 → 折叠为结构化 target（无 raw）
test('codeToActions folds a plain locator into a structured target', () => {
  const [a] = pw.codeToActions("await page.getByRole('textbox', { name: 'Email' }).fill('a@b.com');");
  assert.strictEqual(a.raw, undefined);
  assert.deepStrictEqual(a.target, { by: 'role', role: 'textbox', value: 'Email' });
  assert.strictEqual(a.value, 'a@b.com');
});

// 4) actions → code → actions 往返一致（关键字段）
test('actions -> code -> actions round-trips', () => {
  const actions = [
    { type: 'fill', target: { by: 'role', role: 'textbox', value: 'Email' }, value: 'a@b.com' },
    { type: 'check', target: { by: 'css', value: "input[name='q1'][value='yes']" } },
    { type: 'fill', raw: "page.getByText('References').locator('..').getByRole('textbox')", target: { by: 'css', value: '' }, value: 'line1\nline2' },
  ];
  const back = pw.codeToActions(pw.actionsToCode(actions));
  assert.strictEqual(back.length, 3);
  assert.deepStrictEqual(back[0].target, actions[0].target);
  assert.strictEqual(back[0].value, 'a@b.com');
  assert.strictEqual(back[2].raw, actions[2].raw);
  assert.strictEqual(back[2].value, 'line1\nline2');
});

// 5) target → code 与 target → selector 在「有/无 name 的 role」上语义一致
test('locatorCode and targetToSelector agree on role targets', () => {
  const named = { by: 'role', role: 'textbox', value: 'Email' };
  assert.strictEqual(pw.locatorCode(named), "getByRole('textbox', { name: 'Email' })");
  assert.strictEqual(pw.targetToSelector(named), 'internal:role=textbox[name="Email"i]');
  const noName = { by: 'role', role: 'option', value: '' };
  // 两端都表达「取第一个」：代码用 .first()，selector 用 nth=0
  assert.ok(pw.locatorCode(noName).endsWith('.first()'));
  assert.ok(pw.targetToSelector(noName).endsWith(' >> nth=0'));
});

// 6) chainToSelector：链段 → selector（含 .first() → nth=0）
test('chainToSelector encodes a getByRole chain with .first()', () => {
  const segs = [
    { name: 'getByRole', call: true, args: ['textbox', { name: 'Email' }] },
    { name: 'first', call: true, args: [] },
  ];
  assert.strictEqual(pw.chainToSelector(segs), 'internal:role=textbox[name="Email"i] >> nth=0');
});

// 7) safeCss：含不安全字符的 #id 改写为属性选择器
test('safeCss rewrites unsafe #id selectors', () => {
  assert.strictEqual(pw.safeCss('#Country/Region'), '[id="Country/Region"]');
  assert.strictEqual(pw.safeCss('#normal_id-1'), '#normal_id-1'); // 安全的保持不变
});

console.log(`\n${passed} passed`);
