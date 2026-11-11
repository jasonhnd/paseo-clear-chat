const assert=require('node:assert/strict');const test=require('node:test');const {readFileSync}=require('node:fs');const {resolve}=require('node:path');
const source=readFileSync(resolve(__dirname,'preferences.test.cjs'),'utf8');const end=source.indexOf('\ntest(');assert.ok(end>0);
const {harness,host}=new Function('require','__dirname',source.slice(0,end)+'\nreturn {harness,host};')(require,__dirname);
const legacy=JSON.stringify({answerStyle:'casual',savedReplies:['From browser'],autoFillAnswer:false,showJumpChips:true,showAnswerCard:true,accent:'jade',assistantMarkdown:false});
test('browser snapshot cannot seed new host-only fields when host has no values',async()=>{
 const server=host({preferences:{},legacyMigrated:false});const h=harness('web',legacy);await h.preferences.initializeEnhancerPreferences(server.rpc);
 assert.equal(server.values.legacyMigrated,true);assert.equal(server.values.preferences.accent,'jade');assert.equal(server.values.preferences.assistantMarkdown,false);
 for(const key of ['answerStyle','savedReplies','autoFillAnswer','showJumpChips','showAnswerCard'])assert.equal(Object.hasOwn(server.values.preferences,key),false,`${key} must not migrate from browser`);
});
test('host values win over different browser values while old host-only controls remain excluded',async()=>{
 const server=host({preferences:{answerStyle:'formal',savedReplies:['Host value'],autoFillAnswer:true},legacyMigrated:false});const h=harness('web',legacy);await h.preferences.initializeEnhancerPreferences(server.rpc);
 assert.equal(server.values.preferences.answerStyle,'formal');assert.deepEqual(server.values.preferences.savedReplies,['Host value']);assert.equal(server.values.preferences.autoFillAnswer,true);
 assert.equal(Object.hasOwn(server.values.preferences,'showJumpChips'),false);assert.equal(Object.hasOwn(server.values.preferences,'showAnswerCard'),false);assert.equal(server.values.preferences.accent,'jade');
});
