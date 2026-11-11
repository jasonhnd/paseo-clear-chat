const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const questions = '1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\nC Three\nD Four\n\n3) Third?\nA One\nB Two\n\nReply: A';
const zeroQuestions = '0. First?\nA Alpha\nB Beta\n\n1. Second?\nA Alpha\nB Beta\n\nReply: A';
function fixture(t, draftByKey={}) {
 const h=createToolHarness('web'); const s=h.load('client/option-session.ts');
 const data={...draftByKey}; s.setAnswerDraftStore({read:k=>data[k],write:(k,v)=>{data[k]=v},clear:k=>{delete data[k]}});
 t.after(()=>{s.setAnswerDraftStore(null);h.unmount();h.dispose()}); return {s,data};
}
const valid={schema:1,choices:{0:'B'},customDrafts:{},customOpen:{},activeQuestion:1};
const put=(s,data,id,at,value=valid)=>{data[s.answerDraftKey(id,at)]=value};

test('new-version valid draft plus ordinary message stays editable, no invented answers', t=>{
 const {s,data}=fixture(t);put(s,data,'a',10);s.publishAssistantReply('a',{at:10,text:questions});s.publishUserMessage('a',11,'Please wait until tomorrow.');
 const card=s.getOptionSessionAt('a',10);assert.equal(card.readOnly,false);assert.equal(card.choices[0],'B');assert.equal(card.choices[1],undefined);
});
test('ordinary message with no valid draft retains legacy read-only raw echo', t=>{
 const {s}=fixture(t);s.publishAssistantReply('a',{at:10,text:questions});s.publishUserMessage('a',11,'Please wait until tomorrow.');const c=s.getOptionSessionAt('a',10);assert.equal(c.readOnly,true);assert.equal(c.answeredText,'Please wait until tomorrow.');
});
test('malformed draft or uncertain identity cannot unlock legacy behavior', t=>{
 const {s,data}=fixture(t);put(s,data,'a',10,{schema:2,choices:{0:'B'}});s.publishAssistantReply('a',{at:10,text:questions});s.publishUserMessage('a',11,'Please wait until tomorrow.');assert.equal(s.getOptionSessionAt('a',10).readOnly,true);
});
test('current numbered answer remains read-only and exact', t=>{
 const {s,data}=fixture(t);put(s,data,'a',10);s.publishAssistantReply('a',{at:10,text:questions});s.publishUserMessage('a',11,'1B 2A 3B');const c=s.getOptionSessionAt('a',10);assert.equal(c.readOnly,true);assert.deepEqual(c.choices,{0:'B',1:'A',2:'B'});assert.equal(c.answeredText,'1B 2A 3B');
});
test('legacy numbered answer remains read-only and exact', t=>{
 const {s,data}=fixture(t);put(s,data,'a',10);s.publishAssistantReply('a',{at:10,text:zeroQuestions});s.publishUserMessage('a',11,'0B 1A');const c=s.getOptionSessionAt('a',10);assert.equal(c.readOnly,true);assert.deepEqual(c.choices,{0:'B',1:'A'});assert.equal(c.answeredText,'0B 1A');
});
test('recognised custom answer remains read-only, exact and takes priority', t=>{
 const {s,data}=fixture(t);put(s,data,'a',10);s.publishAssistantReply('a',{at:10,text:questions});const message='1B 2E 3A\n\n2E：\n  snow 🌸\nline 2';s.publishUserMessage('a',11,message);const c=s.getOptionSessionAt('a',10);assert.equal(c.readOnly,true);assert.equal(c.answeredText,message);assert.equal(c.customConfirmed[1],'  snow 🌸\nline 2');
});
test('ambiguous numbered text remains read-only, with raw original', t=>{
 const {s,data}=fixture(t);put(s,data,'a',10);s.publishAssistantReply('a',{at:10,text:questions});const text='1B maybe';s.publishUserMessage('a',11,text);const c=s.getOptionSessionAt('a',10);assert.equal(c.readOnly,true);assert.equal(c.answeredText,text);
});
test('draft identity stays isolated across agents and card timestamps', t=>{
 const {s,data}=fixture(t);put(s,data,'a',10);s.publishAssistantReply('a',{at:10,text:questions});s.publishUserMessage('a',11,'Please wait until tomorrow.');s.publishAssistantReply('a',{at:20,text:questions});s.publishUserMessage('a',21,'Please wait until tomorrow.');s.publishAssistantReply('b',{at:10,text:questions});s.publishUserMessage('b',11,'Please wait until tomorrow.');assert.equal(s.getOptionSessionAt('a',10).readOnly,false);assert.equal(s.getOptionSessionAt('a',20).readOnly,true);assert.equal(s.getOptionSessionAt('b',10).readOnly,true);
});
test('ordinary follow-up created after an actual draft write keeps that card editable', async t=>{
 const {s}=fixture(t);s.publishAssistantReply('a',{at:10,text:questions});s.choose('a',0,'B');await new Promise(r=>setTimeout(r,650));s.publishUserMessage('a',11,'Please wait until tomorrow.');const c=s.getOptionSessionAt('a',10);assert.equal(c.readOnly,false);assert.equal(c.choices[0],'B');
});

test('answer-like prose and unsupported freeform messages remain read-only when classification is uncertain', t=>{
 for (const text of ['I prefer the latter', 'Please choose option A', '1B maybe', '2E：\nunfinished']) {
  const {s,data}=fixture(t);put(s,data,'a',10);s.publishAssistantReply('a',{at:10,text:questions});s.publishUserMessage('a',11,text);const c=s.getOptionSessionAt('a',10);assert.equal(c.readOnly,true, text);assert.equal(c.answeredText,text);
 }
});
test('schema-only incomplete draft does not qualify as a valid new-version record', t=>{
 const {s,data}=fixture(t);put(s,data,'a',10,{schema:1,activeQuestion:0});s.publishAssistantReply('a',{at:10,text:questions});s.publishUserMessage('a',11,'Please wait until tomorrow.');assert.equal(s.getOptionSessionAt('a',10).readOnly,true);
});
