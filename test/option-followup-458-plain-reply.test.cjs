const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

test('a later plain assistant reply leaves the existing answer card resumable', async t => {
 const h = createToolHarness('web');
 const s = h.load('client/option-session.ts');
 const data = {};
 s.setAnswerDraftStore({read:k=>data[k],write:(k,v)=>{data[k]=v},clear:k=>{delete data[k]}});
 t.after(()=>{s.setAnswerDraftStore(null);h.unmount();h.dispose()});
 data[s.answerDraftKey('a',10)] = {schema:1,choices:{0:'B'},customDrafts:{},customOpen:{},activeQuestion:1};
 s.publishAssistantReply('a',{at:10,text:'1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A'});
 s.publishUserMessage('a',11,'Please wait until tomorrow.');
 s.publishAssistantReply('a',{at:12,text:'I will wait.'});
 const card = s.getOptionSessionAt('a',10);
 assert.equal(card.readOnly,true);
 assert.equal(card.followupStatus,'waiting');
 assert.equal(card.choices[0],'B');
 assert.equal(await s.resumeAnswerDraft('a',10),true);
 assert.equal(s.getOptionSessionAt('a',10).readOnly,false);
 assert.equal(s.getOptionSessionAt('a',10).choices[0],'B');
});
