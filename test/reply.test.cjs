const assert = require('node:assert/strict');
const { selectReplyEntry } = require('../.tmp-test/batch/reply.js');

const candidate = (values = {}) => ({
  locator: values.locator || '#reply', text: '', ariaLabel: '', title: '', className: '', id: '',
  visible: true, enabled: true, inCommentContext: true, highConfidence: false, inExcludedRegion: false,
  ...values,
});

let count = 0;
function test(name, fn) { fn(); count++; console.log('  ✓ ' + name); }

test('WordPress reply link has priority and only one deterministic locator is returned', () => {
  const result = selectReplyEntry([
    candidate({locator:'#generic', text:'Reply'}),
    candidate({locator:'#wp-first', text:'Reply', className:'comment-reply-link', highConfidence:true}),
    candidate({locator:'#wp-second', text:'Reply', className:'comment-reply-link', highConfidence:true}),
  ]);
  assert.deepEqual(result, {locator:'#wp-first'});
});
test('login-only reply is reported as authentication and is never selected', () => {
  assert.deepEqual(selectReplyEntry([candidate({text:'Log in to reply'})]), {requiresAuth:true});
});
test('email reply, share, report, prose and navigation controls are rejected', () => {
  assert.equal(selectReplyEntry([
    candidate({text:'Reply by email'}), candidate({text:'Email reply'}), candidate({text:'Share'}), candidate({text:'Report'}),
    candidate({text:'Reply', inCommentContext:false}), candidate({text:'Reply', inExcludedRegion:true}),
  ]), null);
});
test('a visible enabled generic Reply in comment context is accepted', () => {
  assert.deepEqual(selectReplyEntry([candidate({locator:'#reply-two', text:'Reply to Ada'})]), {locator:'#reply-two'});
});
test('hidden and disabled reply controls are ignored', () => {
  assert.equal(selectReplyEntry([candidate({text:'Reply', visible:false}), candidate({text:'Reply', enabled:false})]), null);
});
console.log(`${count} reply selection tests passed`);
