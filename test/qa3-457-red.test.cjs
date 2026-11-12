const assert=require("node:assert/strict"),test=require("node:test"),fs=require("node:fs");
const {createToolHarness}=require("./helpers/tool-harness.cjs");
const oracle=JSON.parse(fs.readFileSync(require("node:path").join(__dirname,"fixtures","oracle-457.json"),"utf8"));
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(t,initial="",sel={start:0,end:0}){
 let value=initial,selection={...sel},sent=0;
 const composer={get prompt(){return value},setPrompt(x){value=x},insertText(x){value=value.slice(0,selection.start)+x+value.slice(selection.end)},async focus(o){if(o?.selection)selection=o.selection}};
 const h=createToolHarness("ios",{agents:{a:{status:"idle"}},useComposers:()=>[composer]});t.after(()=>{h.unmount();h.dispose()});
 const s=h.load("client/option-session.ts"),Card=h.load("client/components/option-card.tsx").OptionCard;s.setOptionSender(async()=>{sent++});
 const draw=()=>h.draw({type:Card,props:{agentId:"a",at:1,tokens:h.tokens}});
 const press=id=>{const n=h.nodes(draw(),x=>x.props.testID===id)[0];assert.ok(n,"missing control "+id);n.props.onPress()};
 return {h,s,press,get value(){return value},get sent(){return sent},get selection(){return selection}};
}
function ready(f,o){f.s.publishAssistantReply("a",{at:1,text:o.reply});f.s.choose("a",0,"B");f.s.setCustomDraft("a",1,o.answers[1].content);assert.equal(f.s.confirmCustom("a",1),"confirmed");}
test("ordinary answer inserts only identifier and never sends",async t=>{const f=fixture(t);f.s.publishAssistantReply("a",{at:1,text:"Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A"});f.press("option-row-C");f.press("option-send");await tick();assert.equal(f.value,"1C");assert.equal(f.sent,0)});
test("custom empty composer receives exact baseline formatter message",async t=>{const o=oracle.find(x=>x.id==="mixed"),f=fixture(t);ready(f,o);f.press("option-send");await tick();assert.equal(f.value,o.message);assert.equal(f.sent,0)});
test("custom insertion preserves selected user text and inserts complete message",async t=>{const o=oracle.find(x=>x.id==="mixed"),old="USER-原文-selected",f=fixture(t,old,{start:5,end:7});ready(f,o);f.press("option-send");await tick();assert.ok(f.value.includes(old),"original selected text lost: "+JSON.stringify(f.value));assert.ok(f.value.includes(o.message),"complete formatter message missing: "+JSON.stringify(f.value));assert.equal(f.sent,0)});
test("legacy numbered question inserts baseline canonical message",async t=>{const o=oracle.find(x=>x.id==="legacy"),f=fixture(t);ready(f,o);f.press("option-send");await tick();assert.equal(f.value,o.message);assert.equal(f.sent,0)});
test("history already answered does not write composer",async t=>{const o=oracle.find(x=>x.id==="mixed"),f=fixture(t);f.s.publishAssistantReply("a",{at:1,text:o.reply});f.s.publishUserMessage("a",2,o.message);await tick();assert.equal(f.s.getOptionSession("a",1).readOnly,true);assert.equal(f.value,"");assert.equal(f.sent,0)});
