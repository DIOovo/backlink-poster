const assert=require('node:assert/strict');
const {detectBatchForm}=require('../.tmp-test/utils/ai.js');
const config={provider:'custom',model:'configured-test-model',baseUrl:'http://127.0.0.1:8765/v1',apiKey:'synthetic-test-key'};
const mapping={found:true,formType:'reply',confidence:.94,fields:{content:{locator:'aria-ref=e2',required:true}},submit:{locator:'aria-ref=e3'}};
(async()=>{
 const original=global.fetch;let calls=0;
 try {
  global.fetch=async(url,options)=>{
   calls++;assert.equal(url,'http://127.0.0.1:8765/v1/chat/completions');
   const body=JSON.parse(options.body);assert.equal(body.model,config.model);assert.match(body.messages[0].content,/reply_trigger/);assert.match(body.messages[0].content,/Never return page.locator code/);assert.equal(body.messages[1].content,'candidate snapshot');
   return {ok:true,json:async()=>({choices:[{message:{content:'```json\n'+JSON.stringify(mapping)+'\n```'},finish_reason:'stop'}]})};
  };
  assert.deepEqual(await detectBatchForm(config,'candidate snapshot'),mapping);
  global.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"found":false}'},finish_reason:'stop'}]})});
  assert.deepEqual(await detectBatchForm(config,'candidate snapshot'),{found:false});
  const reply={found:true,strategy:'reply_trigger',replyLocator:'aria-ref=e7',confidence:.91};
  global.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(reply)},finish_reason:'stop'}]})});
  assert.deepEqual(await detectBatchForm(config,'candidate snapshot'),reply);
  global.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"found":true}'},finish_reason:'stop'}]})});
  await assert.rejects(()=>detectBatchForm(config,'snapshot'),/invalid/);
  global.fetch=async()=>({ok:false,status:503,json:async()=>({error:{message:'Synthetic unavailable'}})});
  await assert.rejects(()=>detectBatchForm(config,'snapshot'),/503/);
  console.log('  ✓ AI fallback uses configured provider/model, parses JSON, handles not-found, invalid mappings and API failures');
 } finally {global.fetch=original}
})().catch(e=>{console.error(e);process.exitCode=1});
