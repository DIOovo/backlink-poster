const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');globalThis.crypto||=webcrypto;
const {parseExcelUrlRows}=require('../.tmp-test/batch/excel.js');
let count=0;const test=(name,fn)=>{fn();count++;console.log('  ✓ '+name)};

test('header detection accepts URL casing and surrounding whitespace',()=>{
 for(const header of ['URL','url','Url','  URL  ']){
  const r=parseExcelUrlRows([[header],['https://example.com/a']]);assert.equal(r.total,1);assert.equal(r.valid,1);assert.equal(r.tasks[0].url,'https://example.com/a');
 }
});
test('first row is data when no URL header is present',()=>{
 const r=parseExcelUrlRows([['https://example.com/first'],['http://example.com/second']]);assert.equal(r.total,2);assert.equal(r.valid,2);
});
test('blank rows and cells are ignored while URL whitespace is trimmed',()=>{
 const r=parseExcelUrlRows([['URL'],[],[null],['   '],['  https://example.com/trim  ']]);assert.equal(r.total,1);assert.equal(r.tasks[0].url,'https://example.com/trim');
});
test('invalid URLs are listed, schemes are required, and exact duplicates are removed',()=>{
 const r=parseExcelUrlRows([['URL'],['example.com/no-scheme'],['abc'],[123],['https://example.com/x'],['https://example.com/x'],['https://example.com/X'],['http://example.com/x']]);
 assert.deepEqual({total:r.total,valid:r.valid,duplicate:r.duplicate,invalid:r.invalid},{total:7,valid:3,duplicate:1,invalid:3});
 assert.equal(r.total,r.valid+r.duplicate+r.invalid);assert.deepEqual(r.invalidRows.map(x=>x.row),[2,3,4]);assert.ok(r.tasks.every(t=>t.contentSource==='AI'&&t.content===''));
});
test('one hundred unique URLs create one hundred isolated READY tasks',()=>{
 const rows=[['URL'],...Array.from({length:100},(_,i)=>[`https://example.com/article-${i+1}?item=${i}`])];const r=parseExcelUrlRows(rows);
 assert.equal(r.total,100);assert.equal(r.valid,100);assert.equal(r.duplicate,0);assert.equal(r.invalid,0);assert.equal(new Set(r.tasks.map(t=>t.id)).size,100);assert.ok(r.tasks.every(t=>t.status==='READY'));
});
console.log(`${count} Excel import tests passed`);
