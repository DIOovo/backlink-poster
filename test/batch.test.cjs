const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
globalThis.crypto ||= webcrypto;
const m = require('../.tmp-test/batch/model.js');
let count = 0;
function test(name, fn) { try { fn(); count++; console.log('  ✓ ' + name); } catch (e) { console.error(name, e); process.exitCode = 1; } }
test('CSV handles BOM, CRLF, embedded commas, quotes and newlines', () => {
 const tasks = m.parseTasks('\uFEFFurl,content\r\nhttps://example.com,"Hi, ""there""\nsecond line"\r\n', 'csv');
 assert.equal(tasks.length, 1); assert.equal(tasks[0].content, 'Hi, "there"\nsecond line'); assert.equal(tasks[0].status, 'READY');
});
test('TSV keeps content whitespace and extra tabs', () => assert.equal(m.parseTasks('https://example.com\t A\tB ', 'tsv')[0].content, ' A\tB '));
test('Bad rows, protocols and quotes fail visibly', () => {
 for (const input of ['url,content\nhttps://example.com,"bad', 'url,content\nhttps://example.com,"one"x', 'url,content\nhttps://example.com,', 'url,content\nhttps://example.com,a,b', 'url,content\njavascript:alert(1),hi']) assert.throws(() => m.parseTasks(input, 'csv'));
 assert.throws(() => m.parseTasks('https://example.com no-tab', 'tsv'));
 assert.throws(() => m.validateUrl('https://user:pass@example.com'));
});
test('Result export round-trips exact multiline Content and generated Unicode', () => {
 const task = {id:'1', url:'https://example.com',content:'Hi, "there"\nnext',contentSource:'AI',generationStatus:'SUCCESS',generatedContent:'实用, "分析"\n次の行 🚀',status:'SUBMIT_FAILED',error:'One, "two"\nthree'};
 task.entryStrategy = 'REPLY_TRIGGER_LOCAL';
 const csv = m.parseCSV(m.resultsCSV([task])); assert.equal(csv[1][2], task.content); assert.equal(csv[1][3], 'AI'); assert.equal(csv[1][4], 'SUCCESS'); assert.equal(csv[1][5], task.generatedContent); assert.equal(csv[1][8], task.entryStrategy); assert.equal(csv[1][14], task.error); assert.equal(csv[0].length, 15);
});
test('Downloads folder rejects absolute/traversal and invalid paths', () => {
 for (const path of ['/Users/name', '../out', 'a/../b', 'C:\\a', 'a//b', './folder', 'a/.. ']) {
  assert.throws(() => m.validateFolder(path), path);
 }
 assert.equal(m.validateFolder('backlink-results/2026-10-02/'), 'backlink-results/2026-10-02');
});
test('Screenshot names include padded index, host and actual status', () => {
 assert.equal(m.screenshotName({url:'https://example.com',status:'PENDING_MODERATION'},1), '002-example.com-pending.png');
});
test('AI mapping is schema validated, missing optional identity is valid', () => {
 const good = {found:true,formType:'comment',confidence:.9,fields:{content:{locator:'css=textarea',required:true}},submit:{locator:'css=button'}};
 assert.equal(m.validateDetection(good).found,true); assert.deepEqual(m.validateDetection({found:false}),{found:false});
 for (const bad of [{...good,confidence:.2},{...good,formType:'login'},{...good,submit:{}},{...good,fields:{content:{locator:'page.locator("textarea")',required:true}}}]) assert.throws(() => m.validateDetection(bad));
});
test('AI reply trigger is schema validated as untrusted data', () => {
 const good = {found:true,strategy:'reply_trigger',replyLocator:'aria-ref=e7',confidence:.92};
 assert.deepEqual(m.validateDetection(good),good);
 for (const bad of [{...good,confidence:.2},{...good,replyLocator:'page.locator("button")'},{...good,replyLocator:''}]) assert.throws(() => m.validateDetection(bad));
});
console.log(`${count} batch tests passed`);
