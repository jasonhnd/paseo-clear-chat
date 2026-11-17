const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const spec=readFileSync(path.join(__dirname,'translations.test.cjs'),'utf8');
const start=spec.indexOf('const approvedResourceHashes = {');
const end=spec.indexOf('for (const locale of ["en", "zh-CN", "ja"]) {',start);
assert.ok(start>=0 && end>start);
const resources=Object.fromEntries(['en','zh-CN','ja'].map(l=>[l,JSON.parse(readFileSync(path.join(__dirname,'../client/locales',`${l}.json`),'utf8'))]));
const verify=new Function('assert','createHash','resources',spec.slice(start,end)+'\nreturn verifyResourceBaseline;')(assert,createHash,resources);
for(const locale of ['en','zh-CN','ja']){
 const text=readFileSync(path.join(__dirname,'../client/locales',`${locale}.json`),'utf8');
 const block=text.match(/,\n  "answerStyle": \{\n(?:    .*\n)*  \}/)?.[0];
 test(`${locale}: exact authorised new object and original baseline`,()=>{assert.ok(block);assert.doesNotThrow(()=>verify(locale,text));});
 test(`${locale}: rejects changed values, missing and duplicate keys or object, and old fields`,()=>{
  assert.ok(block);const title=block.match(/^    "title": .*\n/m)[0];const brief=block.match(/^    "concise": .*\n/m)[0];
  const cases=[text.replace(title,title.replace(': "',': "changed ')),text.replace(brief,''),text.replace(title,title+title),text.replace(block,block+block),text.replace('"startupFailed": "','"startupFailed": "changed ')];
  for(const changed of cases){assert.notEqual(changed,text);assert.throws(()=>verify(locale,changed));}
 });
}
