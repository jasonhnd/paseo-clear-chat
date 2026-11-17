'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {readFileSync}=require('node:fs');const path=require('node:path');const {boardSection,localDayBounds}=require('../client/agent-board-model.ts');
const run=fn=>{const old=process.env.TZ;process.env.TZ='Asia/Tokyo';try{fn()}finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old}};
// finishedAt is deliberately test-only history, not a claimed host API field.
// The current contract uses the snapshot's lastActivityAt, not this history.
const history={status:'idle',attentionReason:'finished',finishedAt:'2026-11-11T14:30:00.000Z',title:'Renamed today'};
test('finished yesterday with title updated today appears under finished today',()=>run(()=>{const b=localDayBounds(Date.parse('2026-11-11T16:00:00.000Z'));assert.equal(boardSection({...history,lastActivityAt:'2026-11-11T15:30:00.000Z'},b),'finished')}));
test('finished yesterday without an update today does not appear',()=>run(()=>{const b=localDayBounds(Date.parse('2026-11-11T16:00:00.000Z'));assert.equal(boardSection({...history,lastActivityAt:'2026-11-11T14:30:00.000Z'},b),null)}));
test('section title is Finished today in English and 今天完成 in Simplified Chinese',()=>{const s=readFileSync(path.join(__dirname,'../client/messages.ts'),'utf8');const en=s.slice(s.indexOf('const sidebarEn'),s.indexOf('const sidebarZhCN'));const zh=s.slice(s.indexOf('const sidebarZhCN'),s.indexOf('export const messages'));assert.match(en,/finished:\s*"Finished today"/);assert.match(zh,/finished:\s*"今天完成"/)});
