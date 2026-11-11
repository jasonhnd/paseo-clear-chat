const test=require('node:test');const assert=require('node:assert/strict');const {createToolHarness}=require('./helpers/tool-harness.cjs');
test('reader style persists in host settings and survives a fresh client',async t=>{
 let values={preferences:{},legacyMigrated:true},revision=0;
 const rpc=async(contract,input)=>{if(contract.name.endsWith('.read'))return {status:'ready',revision:String(revision),values:structuredClone(values)};if(input.revision!==String(revision))return {status:'conflict'};values=structuredClone(input.values);revision++;return {status:'saved',values:structuredClone(values)};};
 const h1=createToolHarness('web',{presentationHost:{rpc}}),h2=createToolHarness('web',{presentationHost:{rpc}});t.after(()=>{h1.unmount();h1.dispose();h2.unmount();h2.dispose()});
 const p1=h1.load('client/preferences.ts'),m1=h1.load('client/components/answer-style-control.tsx');await p1.initializeEnhancerPreferences(rpc);assert.equal(m1.getAnswerStyle(),'none');m1.setAnswerStyle('formal');await p1.updateEnhancerPreferences({});assert.equal(values.preferences.answerStyle,'formal');
 const p2=h2.load('client/preferences.ts'),m2=h2.load('client/components/answer-style-control.tsx');await p2.initializeEnhancerPreferences(rpc);assert.equal(m2.getAnswerStyle(),'formal');assert.equal(m2.composeAnswerText('1B',undefined,'en'),'1B Use a formal tone.');
});
