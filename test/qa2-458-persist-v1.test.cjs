const assert = require('node:assert/strict');
const test = require('node:test');
const {createToolHarness}=require('/data/home/w/test/helpers/tool-harness.cjs');
const draft={schema:1,choices:{0:'B'},customDrafts:{},customOpen:{},activeQuestion:1};
function host(){
 let values={preferences:{},legacyMigrated:true,answerDrafts:{}}, rev=0, block=null, release=null, fail=false;
 const calls=[];
 return {calls,get values(){return structuredClone(values)},setFail(v){fail=v},
  blockWrite(){block=new Promise(resolve=>{release=resolve})},release(){release?.();block=null},
  async rpc(c,input){calls.push(c.name);if(c.name.endsWith('.read'))return {status:'ready',revision:String(rev),values:structuredClone(values)};
   if(block)await block;if(fail)throw Error('QA_HOST_WRITE_REJECTED');
   if(input.revision!==String(rev))return {status:'conflict',error:'Changed elsewhere'};
   values=structuredClone(input.values);rev++;return {status:'saved',revision:String(rev),values:structuredClone(values)};
  }};
}
async function setup(t){
 const h=createToolHarness('web',{presentationHost:true});t.after(()=>{h.unmount();h.dispose()});
 const p=h.load('client/preferences.ts');const server=host();await p.initializeEnhancerPreferences(server.rpc);return {p,server};
}
const isPromise=x=>!!x&&typeof x.then==='function';
test('draft write returns completion only after host settles',async t=>{
 const {p,server}=await setup(t);server.blockWrite();let ret;
 try {ret=p.storeAnswerDraft('a\0card1',draft);assert.ok(isPromise(ret),'write must return an observable completion promise');
  let settled=false;ret.then(()=>{settled=true},()=>{settled=true});await new Promise(r=>setTimeout(r,40));
  assert.equal(settled,false,'write must remain pending while the host is blocked');
 } finally {server.release();}
 await ret;assert.deepEqual(server.values.answerDrafts['a\0card1'],draft,'success must reflect persisted host value');
});
test('draft write rejects when host rejects and later legacy settings still save',async t=>{
 const {p,server}=await setup(t);server.setFail(true);const ret=p.storeAnswerDraft('a\0card1',draft);
 assert.ok(isPromise(ret),'write failure must be observable as a completion promise');
 await assert.rejects(ret);server.setFail(false);
 await p.updateEnhancerPreferences({assistantMarkdown:true});assert.equal(server.values.preferences.assistantMarkdown,true,'a failed draft must not poison the existing queue');
});
test('draft clear returns host completion and preserves other card and agent',async t=>{
 const {p,server}=await setup(t);
 const entries=[['a\0card1',draft],['a\0card2',{...draft,choices:{0:'A'}}],['b\0card1',draft]];
 for(const [k,v] of entries){const r=p.storeAnswerDraft(k,v);if(isPromise(r))await r;else await p.updateEnhancerPreferences({assistantMarkdown:true});}
 server.blockWrite();let ret;
 try{ret=p.clearStoredAnswerDraft('a\0card1');assert.ok(isPromise(ret),'clear must return an observable completion promise');
 let settled=false;ret.then(()=>{settled=true},()=>{settled=true});await new Promise(r=>setTimeout(r,40));assert.equal(settled,false,'clear must wait for host');
 }finally{server.release();}
 await ret;const saved=server.values.answerDrafts;assert.equal(saved['a\0card1'],undefined);assert.deepEqual(saved['a\0card2'],entries[1][1]);assert.deepEqual(saved['b\0card1'],draft);
});
test('draft clear rejects on host failure without pretending removal',async t=>{
 const {p,server}=await setup(t);const w=p.storeAnswerDraft('a\0card1',draft);if(isPromise(w))await w;else await p.updateEnhancerPreferences({assistantMarkdown:true});
 server.setFail(true);const ret=p.clearStoredAnswerDraft('a\0card1');assert.ok(isPromise(ret),'clear failure must be observable');await assert.rejects(ret);assert.deepEqual(server.values.answerDrafts['a\0card1'],draft);
});
