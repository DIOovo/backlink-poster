const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
globalThis.crypto ||= webcrypto;
const nativeTimeout = global.setTimeout;
// Only collapse deliberate render/retry delays. Deadlines retain real time.
global.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms <= 3000 ? 0 : ms, ...args);
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = () => {
 const listeners = new Set();
 return {addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => {for(const fn of listeners) fn(...args)}};
};
function storage(initial={}) {
 const values = structuredClone(initial);
 return {values,async get(keys){const out={};for(const key of typeof keys==='string'?[keys]:keys||Object.keys(values)) if(key in values)out[key]=structuredClone(values[key]);return out},async set(v){Object.assign(values,structuredClone(v))},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete values[k]}};
}
// In-memory native messaging host: writes into nativeFiles and replies with absolute paths.
function nativeHostSimulator(options={}) {
 const files = Object.create(null);
 const outRoot = '/Users/test/backlink-results';
 return {
  files,
  connectNative() {
   if (options.nativeUnavailable) throw new Error('Specified native messaging host not found.');
   const onMessage = event();
   const onDisconnect = event();
   const handle = (msg) => {
    let resp;
    try {
     if (msg.action === 'ping') resp = {ok:true, version:'test', outputRoot:outRoot};
     else if (msg.action === 'writeScreenshot') {
      const path = `${outRoot}/${msg.batchId}/screenshots/${msg.filename}`;
      files[path] = {kind:'png', data:msg.data};
      resp = {ok:true, path};
     } else if (msg.action === 'writeCsv') {
      const path = `${outRoot}/${msg.batchId}/results.csv`;
      files[path] = {kind:'csv', data:msg.data};
      resp = {ok:true, path};
     } else resp = {ok:false, error:'unknown action'};
    } catch(e) { resp = {ok:false, error: String(e && e.message || e)}; }
    onMessage.emit(resp);
   };
   return {postMessage(msg){ setImmediate(() => handle(msg)); }, disconnect(){}, onMessage, onDisconnect};
  }
 };
}
const baseline={url:'https://example.com/wp',comments:[],moderation:[],success:[],errors:[]};
const detection={found:true,formType:'wordpress_comment',confidence:1,fields:{content:{locator:'#comment',required:true}},submit:{locator:'#submit'}};
const task = (url='https://example.com/wp',id=crypto.randomUUID()) => ({id,url,content:'Test comment',status:'READY'});
async function environment(initial={}, session={}, options={}) {
 const local=storage(initial), memory=storage(session), messages=event(), updated=event(), activated=event();
 const tab={id:9,windowId:1,url:'about:blank',active:true};
 const clicks=[],replyClicks=[],captures=[],navigations=[];
 let replyActivated=false;
 const nativeHost=nativeHostSimulator(options);
 const nativeFiles=nativeHost.files;
 let responseHook=()=>{};
 const chrome={
  storage:{local,session:memory},
  runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onMessage:messages,onStartup:event(),async getPlatformInfo(){return {os:'mac'}},connectNative:name=>nativeHost.connectNative(name)},
  alarms:{onAlarm:event(),async create(){},async clear(){}},windows:{async update(){}},
  tabs:{onUpdated:updated,onRemoved:event(),onActivated:activated,async create(){return {...tab}},async get(){return {...tab}},async query(){return [{...tab}]},
   async update(id,changes){Object.assign(tab,changes);if(changes.url){navigations.push(changes.url);updated.emit(id,{status:'complete'})}return {...tab}},
   async captureVisibleTab(){captures.push(tab.url);if(options.switchTab)activated.emit({windowId:1,tabId:77});return 'data:image/png;base64,AA=='},
   async sendMessage(id,msg){
    switch(msg.type){
     case 'batchPage:detect':return {detection:tab.url.includes('noform') && !(replyActivated && options.formAfterReply)?{found:false}:detection};
     case 'batchPage:findReply':return options.replyResponse || {found:false};
     case 'batchPage:activateReply':
      replyClicks.push(msg.locator);
      if(options.replyActivationError)return {ok:false,error:options.replyActivationError};
      replyActivated=true;return {ok:true};
     case 'batchPage:snapshot':return {snapshot:options.snapshot || '',candidateCount:options.snapshotCandidateCount || 0};
     case 'batchPage:prepare':return {detection};
     case 'batchPage:fill':return {ok:true};
     case 'batchPage:baseline':return {evidence:baseline};
     case 'batchPage:submit':clicks.push(tab.url);await responseHook();return {ok:true};
     case 'batchPage:outcome':return {status:'SUCCESS'};
     case 'batchPage:scrollResult':return {ok:true};
     default:throw new Error('Unexpected '+msg.type);
    }
   }
  }
 };
 global.chrome=chrome;
 const modulePath=require.resolve('../.tmp-test/batch/runner.js');delete require.cache[modulePath];require(modulePath).registerBatchRunner();
 const send=(type,payload={},sender={id:'test',url:'chrome-extension://test/sidepanel.html',tab:{id:1}})=>new Promise(resolve=>messages.emit({type:'batch:'+type,...payload},sender,resolve));
 const wait=async predicate=>{const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw new Error('State timeout: '+JSON.stringify(local.values));await new Promise(r=>nativeTimeout(r,5))}await tick()};
 await tick();
 return {local,memory,clicks,replyClicks,captures,nativeFiles,navigations,send,wait,hook:fn=>{responseHook=fn}};
}
(async()=>{
 let count=0;
 const test=async(name,fn)=>{await fn();count++;console.log('  ✓ '+name)};
 await test('serial batch isolates no-form failure, writes PNG+CSV via native host, and exports',async()=>{
  const env=await environment();
  await env.send('import',{tasks:[task(),task('https://example.com/noform'),task()]});
  await env.send('start',{identity:{name:'A',email:'a@example.com',website:''},rememberIdentity:true,windowId:1});
  await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.deepEqual(env.local.values.batchTasks.map(t=>t.status),['SUCCESS','FORM_NOT_FOUND','SUCCESS']);
  assert.equal(env.clicks.length,2);assert.equal(env.captures.length,3);
  const paths=Object.keys(env.nativeFiles);
  assert.equal(paths.filter(p=>p.endsWith('.png')).length,3);
  assert.equal(paths.filter(p=>p.endsWith('results.csv')).length,1);
  for(const t of env.local.values.batchTasks) if(t.screenshotFilename) assert.ok(paths.includes(t.screenshotFilename),'screenshot path matches written file');
  assert.equal(env.local.values.currentTaskIndex,3);
 });
 await test('direct form keeps DIRECT_FORM strategy and never activates Reply',async()=>{
  const env=await environment();await env.send('import',{tasks:[task()]});await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.equal(env.local.values.batchTasks[0].entryStrategy,'DIRECT_FORM');assert.equal(env.replyClicks.length,0);
 });
 await test('local Reply activation clicks exactly one trigger and finds the form from fresh DOM',async()=>{
  const env=await environment({}, {}, {replyResponse:{locator:'#reply-first'},formAfterReply:true});
  await env.send('import',{tasks:[task('https://example.com/noform')]});await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.equal(env.local.values.batchTasks[0].status,'SUCCESS');assert.equal(env.local.values.batchTasks[0].entryStrategy,'REPLY_TRIGGER_LOCAL');assert.deepEqual(env.replyClicks,['#reply-first']);
 });
 await test('a form moved under the selected comment is rediscovered instead of reusing the old result',async()=>{
  const env=await environment({}, {}, {replyResponse:{locator:'a.comment-reply-link'},formAfterReply:true});
  await env.send('import',{tasks:[task('https://example.com/noform')]});await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.equal(env.local.values.batchTasks[0].status,'SUCCESS');assert.equal(env.local.values.batchTasks[0].detectedFormType,'wordpress_comment');assert.deepEqual(env.replyClicks,['a.comment-reply-link']);
 });
 await test('login Reply records authentication, does not click, and remains FORM_NOT_FOUND',async()=>{
  const env=await environment({}, {}, {replyResponse:{requiresAuth:true}});
  await env.send('import',{tasks:[task('https://example.com/noform')]});await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.equal(env.local.values.batchTasks[0].status,'FORM_NOT_FOUND');assert.equal(env.local.values.batchTasks[0].error,'Reply requires authentication');assert.equal(env.replyClicks.length,0);
 });
 await test('AI Reply trigger is activated once and recorded separately',async()=>{
  const oldFetch=global.fetch;
  global.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"found":true,"strategy":"reply_trigger","replyLocator":"aria-ref=e9","confidence":0.93}'},finish_reason:'stop'}]})});
  try {
   const aiConfig={provider:'custom',model:'test-model',baseUrl:'https://ai.example/v1',apiKey:'test-key'};
   const env=await environment({aiConfig}, {}, {snapshot:'reply candidate',snapshotCandidateCount:1,formAfterReply:true});
   await env.send('import',{tasks:[task('https://example.com/noform')]});await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
   assert.equal(env.local.values.batchTasks[0].status,'SUCCESS');assert.equal(env.local.values.batchTasks[0].entryStrategy,'REPLY_TRIGGER_AI');assert.equal(env.local.values.batchTasks[0].detectionMethod,'ai');assert.deepEqual(env.replyClicks,['aria-ref=e9']);
  } finally {global.fetch=oldFetch}
 });
 await test('broken Reply activation is FORM_NOT_FOUND and does not submit',async()=>{
  const env=await environment({}, {}, {replyResponse:{locator:'#broken'},replyActivationError:'Synthetic reply click failed'});
  await env.send('import',{tasks:[task('https://example.com/noform')]});await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.equal(env.local.values.batchTasks[0].status,'FORM_NOT_FOUND');assert.match(env.local.values.batchTasks[0].error,/Synthetic reply click failed/);assert.equal(env.clicks.length,0);assert.deepEqual(env.replyClicks,['#broken']);
 });
 await test('activated Reply with no resulting form records the required error and still saves a screenshot',async()=>{
  const env=await environment({}, {}, {replyResponse:{locator:'#reply-without-form'}});
  await env.send('import',{tasks:[task('https://example.com/noform')]});await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  const saved=env.local.values.batchTasks[0];
  assert.equal(saved.status,'FORM_NOT_FOUND');assert.equal(saved.error,'Reply activated but comment form not found.');assert.equal(saved.entryStrategy,'REPLY_TRIGGER_LOCAL');assert.ok(saved.screenshotFilename);assert.deepEqual(env.replyClicks,['#reply-without-form']);
 });
 await test('pause completes current submission and screenshot; resume skips completed tasks',async()=>{
  const env=await environment();await env.send('import',{tasks:[task(),task()]});
  env.hook(()=>env.send('pause'));
  await env.send('start',{identity:{name:'A'},rememberIdentity:false,windowId:1});
  await env.wait(()=>env.local.values.batchState==='PAUSED');
  assert.deepEqual(env.local.values.batchTasks.map(t=>t.status),['SUCCESS','READY']);assert.equal(env.captures.length,1);assert.equal(env.local.values.identity,undefined);
  env.hook(()=>{});await env.send('start',{identity:{name:'A'},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.equal(env.clicks.length,2);
 });
 await test('stop waits for current task and exports remaining READY rows',async()=>{
  const env=await environment();await env.send('import',{tasks:[task(),task()]});env.hook(()=>env.send('stop'));
  await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.equal(env.local.values.batchState,'STOPPED');assert.equal(env.clicks.length,1);assert.equal(env.local.values.batchTasks[1].status,'READY');
 });
 await test('worker recovery observes an in-flight submit without clicking again',async()=>{
  const t={...task(),status:'RUNNING',phase:'observing',baseline};
  const env=await environment({batchTasks:[t],batchState:'RUNNING',currentTaskIndex:0,batchRun:{id:'recover',folder:'tests/recover',workerTabId:9,windowId:1}},{batchRunSession:'recover'});
  await env.wait(()=>env.local.values.batchRun?.resultsFilename);assert.equal(env.clicks.length,0);assert.equal(env.local.values.batchTasks[0].status,'SUCCESS');
 });
 await test('browser restart pauses and never touches stale worker tab IDs',async()=>{
  const env=await environment({batchTasks:[{...task(),status:'RUNNING',phase:'submitting',baseline},task()],batchState:'RUNNING',batchRun:{id:'old',folder:'tests/old',workerTabId:9}});
  await env.wait(()=>env.local.values.batchState==='PAUSED');assert.equal(env.captures.length,0);assert.equal(env.clicks.length,0);assert.equal(env.local.values.batchTasks[0].status,'SUBMIT_FAILED');assert.equal(env.local.values.batchRun.workerTabId,undefined);
 });
 await test('capture rejects a changed active tab instead of saving the wrong screenshot',async()=>{
  const env=await environment({}, {}, {switchTab:true});await env.send('import',{tasks:[task()]});await env.send('start',{identity:{},windowId:1});await env.wait(()=>env.local.values.batchRun?.resultsFilename);
  assert.equal(Object.keys(env.nativeFiles).filter(p=>p.endsWith('.png')).length,0);
  assert.equal(Object.keys(env.nativeFiles).filter(p=>p.endsWith('results.csv')).length,1);
  assert.match(env.local.values.batchTasks[0].error,/Tab changed/);assert.equal(env.local.values.batchTasks[0].screenshotFilename,undefined);
 });
 await test('native host unavailable records FILE_SAVE_FAILED without crashing the batch',async()=>{
  const env=await environment({}, {}, {nativeUnavailable:true});await env.send('import',{tasks:[task()]});
  await env.send('start',{identity:{},windowId:1});
  await env.wait(()=>env.local.values.batchState==='COMPLETED');
  assert.equal(env.local.values.batchTasks[0].status,'SUCCESS');
  assert.match(env.local.values.batchTasks[0].error||'',/FILE_SAVE_FAILED/);
  assert.match(env.local.values.batchRun.error||'',/FILE_SAVE_FAILED/);
  assert.equal(Object.keys(env.nativeFiles).length,0);
 });
 await test('reopening a client reads persisted results without restarting any tasks',async()=>{
  const saved={batchState:'COMPLETED',currentTaskIndex:1,batchTasks:[{...task(),status:'SUCCESS',phase:'done',screenshotFilename:'/Users/test/backlink-results/proof.png'}],batchRun:{id:'saved',folder:'saved',resultsFilename:'/Users/test/backlink-results/results.csv'},identity:{name:'Remembered',email:'a@example.com',website:''}};
  const env=await environment(saved);const reopened=await env.send('get');
  assert.deepEqual(reopened.batchTasks,saved.batchTasks);assert.equal(reopened.identity.name,'Remembered');assert.equal(reopened.batchState,'COMPLETED');assert.equal(env.navigations.length,0);
 });
 await test('new import clears persisted previous run; rejects page-origin commands',async()=>{
  const env=await environment({batchState:'COMPLETED',batchRun:{id:'old',folder:'old'}});await env.send('import',{tasks:[task()]});assert.equal(env.local.values.batchRun,null);
  const result=await env.send('import',{tasks:[task()]},{id:'test',url:'https://example.com',tab:{id:9}});assert.match(result.error,/extension page/);
 });
 console.log(`${count} runner tests passed`);
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{global.setTimeout=nativeTimeout});
