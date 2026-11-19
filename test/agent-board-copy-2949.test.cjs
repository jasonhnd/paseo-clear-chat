'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const source=fs.readFileSync(path.join(__dirname,'../client/messages.ts'),'utf8');const section=source.slice(source.indexOf('const sidebarZhCN = {'),source.indexOf('export const messages'));
test('Chinese initializing status says 启动中',()=>assert.match(section,/initializing:\s*"启动中"/));
test('Chinese error status says 出错',()=>assert.match(section,/error:\s*"出错"/));
