const {test}=require('node:test');const assert=require('node:assert/strict');const {createToolHarness}=require('./helpers/tool-harness.cjs');
const text='1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A';
function fixture(t){const h=createToolHarness('web');const s=h.load('client/option-session.ts');s.publishAssistantReply('a',{at:10,text});s.publishAssistantReply('a',{at:20,text});s.publishAssistantReply('b',{at:30,text});t.after(()=>{s.setOptionSender(null);h.unmount();h.dispose()});return s;}
test('open/draft/confirm, cursor, clear/note and read helpers target explicit old at',t=>{
 const s=fixture(t);s.openCustom('a',0,10);s.setCustomDraft('a',0,'old draft',10);assert.equal(s.getOptionSessionAt('a',10).customDrafts[0],'old draft');assert.equal(s.getOptionSession('a').customDrafts[0],undefined);assert.equal(s.confirmCustom('a',0,10),'confirmed');s.setNote('a',1,'old note',10);s.moveCursor('a',1,1,10);s.choose('a',1,'B',10);assert.equal(s.getOptionSessionAt('a',10).cursor[1],1);assert.equal(s.getOptionSessionAt('a',10).notes[1],'old note');s.setNote('a',1,'',10);assert.equal(s.missingQuestion('a',10),null);assert.ok(s.answerText('a',10).includes('old draft'));assert.ok(s.answerIndex('a',10));assert.equal(s.customLetterFor('a',0,10),'C');s.clearChoice('a',1,10);assert.equal(s.missingQuestion('a',10),1);assert.equal(s.getOptionSession('a').choices[1],undefined);assert.equal(s.getOptionSession('b').choices[1],undefined);
});
test('no-at default operations still address the latest card',t=>{
 const s=fixture(t);s.openCustom('a',0);s.setCustomDraft('a',0,'latest');assert.equal(s.confirmCustom('a',0),'confirmed');s.moveCursor('a',1,1);assert.equal(s.getOptionSession('a').customDrafts[0],'latest');assert.equal(s.getOptionSessionAt('a',10).customDrafts[0],undefined);assert.equal(s.getOptionSession('a').cursor[1],1);
});
test('explicit dismissal retires only old card and leaves latest and other agent',t=>{
 const s=fixture(t);s.dismiss('a',10);assert.equal(s.getOptionSessionAt('a',10),null);assert.equal(s.getOptionSession('a').at,20);assert.equal(s.getOptionSession('b').at,30);
});
test('explicit old-card send captures target and settles asynchronously on that card',async t=>{
 const s=fixture(t);s.choose('a',0,'B',10);s.choose('a',1,'A',10);s.choose('a',0,'A');s.choose('a',1,'B');let settle;let sent;s.setOptionSender((id,message)=>{sent=[id,message];return new Promise(r=>{settle=r})});const promise=s.sendAnswer('a',10);assert.equal(s.getOptionSessionAt('a',10).sending,true);assert.equal(s.getOptionSession('a').sending,false);assert.deepEqual(sent,['a','1B 2A']);settle();await promise;assert.equal(s.getOptionSessionAt('a',10).readOnly,true);assert.equal(s.getOptionSessionAt('a',10).answeredText,'1B 2A');assert.equal(s.getOptionSession('a').readOnly,false);assert.equal(s.getOptionSession('b').readOnly,false);
});
test('explicit old-card send failure is assigned only to originating card',async t=>{
 const s=fixture(t);s.choose('a',0,'B',10);s.choose('a',1,'A',10);s.choose('a',0,'A');s.choose('a',1,'B');let reject;s.setOptionSender(()=>new Promise((_,r)=>{reject=r}));const promise=s.sendAnswer('a',10);reject(Error('network failed'));await promise;assert.equal(s.getOptionSessionAt('a',10).error,'network failed');assert.equal(s.getOptionSession('a').error,null);assert.equal(s.getOptionSessionAt('a',10).sending,false);
});
