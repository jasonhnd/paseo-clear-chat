const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const text = '1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\nC Three\nD Four\n\nReply: A';
function make(t, data) {
  const h = createToolHarness('web', { agents: { a: { status: 'idle' } } });
  const s = h.load('client/option-session.ts');
  s.setAnswerDraftStore({read:k=>data[k],write:(k,v)=>{data[k]=structuredClone(v)},clear:k=>{delete data[k]}});
  t.after(()=>{s.setAnswerDraftStore(null);h.unmount();h.dispose()});
  return { h, s, pill:h.load('client/answer-pill.ts') };
}
async function resumed(t) {
  const data={}; const a=make(t,data);
  data[a.s.answerDraftKey('a',10)]={schema:1,choices:{0:'B'},customDrafts:{},customOpen:{},activeQuestion:1};
  a.s.publishAssistantReply('a',{at:10,text});
  a.s.publishUserMessage('a',11,'wait a moment');
  a.s.publishAssistantReply('a',{at:12,text:'Waiting.'});
  assert.equal(await a.s.resumeAnswerDraft('a',10),true);
  return {data,a};
}
test('continued card survives client reload and hides while running',async t=>{
 const {data}=await resumed(t); const b=make(t,data);
 b.s.publishAssistantReply('a',{at:10,text}); b.s.publishUserMessage('a',11,'wait a moment'); b.s.publishAssistantReply('a',{at:12,text:'Waiting.'});
 assert.equal(b.s.getOptionSessionAt('a',10).resumed,true);
 assert.equal(b.s.getOptionSessionAt('a',10).readOnly,false);
 assert.equal(b.pill.currentPillCard('a','running'),null);
 assert.equal(b.pill.currentPillCard('a','idle')?.at,10);
});
test('reloaded resumed card recognizes a typed answer associated with the card',async t=>{
 const {data}=await resumed(t); const b=make(t,data);
 b.s.publishAssistantReply('a',{at:10,text}); b.s.publishUserMessage('a',11,'1B 2A');
 assert.equal(b.s.getOptionSessionAt('a',10).readOnly,true); assert.equal(b.s.getOptionSessionAt('a',10).answeredText,'1B 2A');
});
test('reloaded resumed card recognizes a custom answer associated with the card',async t=>{
 const {data}=await resumed(t); const b=make(t,data);
 b.s.publishAssistantReply('a',{at:10,text}); b.s.publishUserMessage('a',11,'1B 2E\n\n2E：\ncustom text');
 assert.equal(b.s.getOptionSessionAt('a',10).readOnly,true); assert.equal(b.s.getOptionSessionAt('a',10).customConfirmed[1],'custom text');
});
test('sending from reloaded resumed card keeps the exact answer',async t=>{
 const {data}=await resumed(t); const b=make(t,data);
 b.s.publishAssistantReply('a',{at:10,text}); b.s.publishUserMessage('a',11,'wait a moment'); b.s.publishAssistantReply('a',{at:12,text:'Waiting.'});
 b.s.choose('a',1,'A',10); let sent; b.s.setOptionSender(async(_id,value)=>{sent=value}); await b.s.sendAnswer('a',10);
 assert.equal(sent,'1B 2A'); assert.equal(b.s.getOptionSessionAt('a',10).readOnly,true);
});
