const assert=require('node:assert/strict');
const test=require('node:test');
const {createToolHarness}=require('/data/home/w/test/helpers/tool-harness.cjs');
const Q='1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A';
const V={schema:1,choices:{0:'B'},customDrafts:{},customOpen:{},activeQuestion:1};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function setup(t){
 const h=createToolHarness('web',{agents:{a:{status:'idle'},b:{status:'idle'}}});
 const s=h.load('client/option-session.ts');const Card=h.load('client/components/option-card.tsx').OptionCard;
 const data={};const writes=[];s.setAnswerDraftStore({read:k=>data[k],write:(k,v)=>{writes.push({k,v,time:Date.now()});data[k]=v},clear:k=>{delete data[k]}});
 data[s.answerDraftKey('a',10)]=structuredClone(V);s.publishAssistantReply('a',{at:10,text:Q});
 t.after(()=>{s.setAnswerDraftStore(null);h.unmount();h.dispose()});
 const draw=()=>h.draw({type:Card,props:{agentId:'a',at:10,tokens:h.tokens}});
 const button=()=>h.nodes(draw(),n=>typeof n.props?.onPress==='function' && /continue answering|继续作答/i.test(h.text(n)))[0];
 return {h,s,data,writes,draw,button};
}
test('pending 400ms write settles and re-reads before resume',async t=>{
 const f=setup(t);f.s.choose('a',1,'A',10);f.s.publishUserMessage('a',11,'等一下');
 const b=f.button();assert.ok(b,'precondition: Continue answering must exist before pending-write exercise');
 const start=Date.now();b.props.onPress();await delay(650);
 assert.ok(f.writes.some(w=>w.k===f.s.answerDraftKey('a',10)),'pending write must actually complete');
 const c=f.s.getOptionSessionAt('a',10);assert.equal(c.readOnly,false,'unchanged draft can resume after write');
 assert.equal(c.choices[1],'A');console.log('pending_test_elapsed_ms',Date.now()-start);
});
test('changed draft around Continue click must not resume and must request retry',async t=>{
 const f=setup(t);f.s.publishUserMessage('a',11,'等一下');
 const b=f.button();assert.ok(b,'precondition: Continue answering must exist before race exercise');
 b.props.onPress();f.data[f.s.answerDraftKey('a',10)]={...structuredClone(V),choices:{0:'A'}};
 await delay(650);const tree=f.draw();
 assert.equal(f.s.getOptionSessionAt('a',10).readOnly,true,'changed draft must not resume');
 assert.match(f.h.text(tree),/请再点一次|try again|click again/i,'changed draft must request a fresh click');
});
