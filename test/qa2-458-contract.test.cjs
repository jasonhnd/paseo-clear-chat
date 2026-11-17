const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const questions = '1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\n3) Third?\nA One\nB Two\n\nReply: A';
const valid = {schema:1, choices:{0:'B'}, customDrafts:{}, customOpen:{}, activeQuestion:1};
function fixture(t, hasDraft) {
  const h = createToolHarness('web', {agents:{a:{status:'idle'}}});
  const s = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  const data = {};
  s.setAnswerDraftStore({read:k=>data[k],write:(k,v)=>{data[k]=v},clear:k=>{delete data[k]}});
  if (hasDraft) data[s.answerDraftKey('a',10)] = structuredClone(valid);
  s.publishAssistantReply('a',{at:10,text:questions});
  t.after(()=>{s.setAnswerDraftStore(null);h.unmount();h.dispose();});
  return {h,s,draw:()=>h.draw({type:Card,props:{agentId:'a',at:10,tokens:h.tokens}})};
}
const interactive = node => typeof node.props?.onPress === 'function' || typeof node.props?.onClick === 'function';
const continueControls = (h,tree) => h.nodes(tree,n=>interactive(n) && /continue answering|继续作答/i.test(h.text(n)));

test('recognized current answer keeps original read-only despite valid draft',t=>{
  const {s} = fixture(t,true); const msg='1B 2A 3B'; s.publishUserMessage('a',11,msg);
  const card=s.getOptionSessionAt('a',10);
  assert.equal(card.readOnly,true); assert.equal(card.answeredText,msg);
  assert.deepEqual(card.choices,{0:'B',1:'A',2:'B'});
});

test('valid draft plus ordinary follow-up requires explicit continue before editing',t=>{
  const {h,s,draw}=fixture(t,true); s.publishUserMessage('a',11,'Please wait until tomorrow.');
  const tree=draw(); const buttons=continueControls(h,tree);
  assert.equal(buttons.length,1,'unfinished card must expose one Continue answering control');
  const rows=h.nodes(tree,n=>/^option-row-/.test(n.props?.testID||'')&&interactive(n));
  assert.equal(rows.length,0,'unfinished card must not allow editing before Continue answering');
  assert.equal(s.getOptionSessionAt('a',10).choices[0],'B');
});

test('ordinary follow-up without valid draft is ended and has no resume control',t=>{
  const {h,s,draw}=fixture(t,false); s.publishUserMessage('a',11,'Please wait until tomorrow.');
  const tree=draw(); const text=h.text(tree);
  assert.match(text,/ended|已结束/i,'ended state must be visible');
  assert.equal(continueControls(h,tree).length,0);
  assert.equal(s.getOptionSessionAt('a',10).readOnly,true);
});
