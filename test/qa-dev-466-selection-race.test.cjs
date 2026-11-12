const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const byId = (h,tree,id) => h.nodes(tree,n=>n.props.testID===id)[0];
const tick = () => new Promise(resolve=>setTimeout(resolve,0));

test('selection changes after focus while prompt is unchanged: no user text is lost', async t=>{
 let value='hello world', selection={start:0,end:5}, sends=0, writes=0;
 const composer={
  get prompt(){ return value; },
  setPrompt(v){writes++;value=v},
  async focus(options){ if(options?.selection) selection={...options.selection}; queueMicrotask(()=>{selection={start:0,end:5}}); },
  insertText(text){writes++;value=value.slice(0,selection.start)+text+value.slice(selection.end)},
 };
 const h=createToolHarness('ios',{agents:{a:{status:'idle'}},useComposers:()=>[composer]});
 const session=h.load('client/option-session.ts'), Card=h.load('client/components/option-card.tsx').OptionCard;
 session.setOptionSender(async()=>{sends++});
 session.publishAssistantReply('a',{at:1,text:'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A'});
 const draw=()=>h.draw({type:Card,props:{agentId:'a',at:1,tokens:h.tokens}});
 t.after(()=>{h.unmount();h.dispose()});
 byId(h,draw(),'option-row-A').props.onPress();byId(h,draw(),'option-send').props.onPress();await tick();
 assert.ok(value.includes('hello world'),`original user text was changed: ${JSON.stringify(value)}; writes=${writes}`);
 assert.equal(sends,0);
});
