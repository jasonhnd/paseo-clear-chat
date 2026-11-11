const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('/data/home/w/test/helpers/tool-harness.cjs');
const Q = '1) First?\nA One\nB Two\nC Three\n\n2) Second?\nA One\nB Two\n\n3) Third?\nA One\nB Two\n\nReply: A';
const V = {schema:1,choices:{0:'B'},customDrafts:{},customOpen:{},activeQuestion:1};
function setup(t, mode='valid') {
 const h=createToolHarness('web',{agents:{a:{status:'idle'},b:{status:'idle'}}});
 const s=h.load('client/option-session.ts'); const Card=h.load('client/components/option-card.tsx').OptionCard;
 const data={}; const reads=[]; let shouldThrow=mode==='error';
 const store={read:k=>{reads.push(k);if(shouldThrow) throw Error('QA_DRAFT_READ_ERROR');return data[k]},write:(k,v)=>{data[k]=v},clear:k=>{delete data[k]}};
 s.setAnswerDraftStore(mode==='unconfigured'?null:store);
 if(mode==='valid') data[s.answerDraftKey('a',10)]=structuredClone(V);
 if(mode==='invalid') data[s.answerDraftKey('a',10)]={schema:999,choices:{0:'B'}};
 s.publishAssistantReply('a',{at:10,text:Q});
 t.after(()=>{s.setAnswerDraftStore(null);h.unmount();h.dispose()});
 const draw=(agent='a',at=10)=>h.draw({type:Card,props:{agentId:agent,at,tokens:h.tokens}});
 const controls=tree=>h.nodes(tree,n=>typeof n.props?.onPress==='function' && /continue answering|继续作答/i.test(h.text(n)));
 return {h,s,data,store,reads,draw,controls,setThrow:v=>{shouldThrow=v}};
}
const send=(f,text)=>f.s.publishUserMessage('a',11,text);
const noUnsafeLabel=(f,tree)=>{assert.equal(f.controls(tree).length,0,'unsafe state must not expose resume');assert.doesNotMatch(f.h.text(tree),/\bended\b|已结束/i,'unsafe state must not claim ended');};

test('ordinary 等一下 with valid draft provides explicit Continue',t=>{
 const f=setup(t);send(f,'等一下');const tree=f.draw();
 assert.equal(f.controls(tree).length,1,'ordinary text with valid draft needs Continue');
 assert.equal(f.s.getOptionSessionAt('a',10).choices[0],'B');
});
test('ordinary 先看别的 with valid draft provides explicit Continue',t=>{
 const f=setup(t);send(f,'先看别的');assert.equal(f.controls(f.draw()).length,1,'ordinary text is not restricted to waiting whitelist');
});
test('ordinary message with successfully read absent draft is ended without Continue',t=>{
 const f=setup(t,'absent');send(f,'等一下');const tree=f.draw();
 assert.ok(f.reads.includes(f.s.answerDraftKey('a',10)),'must actually read target draft');
 assert.match(f.h.text(tree),/\bended\b|已结束/i);assert.equal(f.controls(tree).length,0);
});
test('duplicate answer-like tokens preserve existing safe read-only state',t=>{
 const f=setup(t);send(f,'1C 1C');const tree=f.draw();
 assert.equal(f.s.getOptionSessionAt('a',10).readOnly,true);noUnsafeLabel(f,tree);
});
test('read error is not successful absent draft',t=>{
 const f=setup(t,'error');send(f,'等一下');const tree=f.draw();
 assert.ok(f.reads.includes(f.s.answerDraftKey('a',10)),'actual store read must throw');
 assert.equal(f.s.getOptionSessionAt('a',10).readOnly,true);noUnsafeLabel(f,tree);
});
test('unconfigured store preserves safe read-only without ended label',t=>{
 const f=setup(t,'unconfigured');send(f,'等一下');const tree=f.draw();
 assert.equal(f.s.getOptionSessionAt('a',10).readOnly,true);noUnsafeLabel(f,tree);
});
test('invalid draft never provides Continue',t=>{
 const f=setup(t,'invalid');send(f,'等一下');const tree=f.draw();
 assert.equal(f.controls(tree).length,0);
});
test('ordinary message cannot restore another card or agent',t=>{
 const f=setup(t);f.s.publishAssistantReply('a',{at:20,text:Q});f.s.publishAssistantReply('b',{at:10,text:Q});
 f.s.publishUserMessage('a',21,'等一下');f.s.publishUserMessage('b',11,'先看别的');
 assert.equal(f.controls(f.draw('a',20)).length,0,'other card must not inherit draft');
 assert.equal(f.controls(f.draw('b',10)).length,0,'other agent must not inherit draft');
});
test('recognized answer takes priority over a valid draft',t=>{
 const f=setup(t);const text='1C 2A 3B';send(f,text);const c=f.s.getOptionSessionAt('a',10);
 assert.equal(c.readOnly,true);assert.equal(c.answeredText,text);assert.deepEqual(c.choices,{0:'C',1:'A',2:'B'});
 assert.equal(f.controls(f.draw()).length,0);
});
