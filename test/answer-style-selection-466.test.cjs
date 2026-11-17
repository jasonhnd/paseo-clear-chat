const {test}=require('node:test');const assert=require('node:assert/strict');const {createToolHarness}=require('./helpers/tool-harness.cjs');
test('style helper does not directly access or replace a selection',t=>{
 const h=createToolHarness('web',{presentationHost:{}});t.after(()=>{h.unmount();h.dispose()});const m=h.load('client/components/answer-style-control.tsx');
 assert.equal(typeof m.insertAnswer,'undefined');assert.equal(m.composeAnswerText('Continue','none','en'),'Continue');
});
