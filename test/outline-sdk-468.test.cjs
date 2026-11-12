'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '../client/outline-model.ts');
const model = fs.existsSync(file) ? require(file) : { syncOutline: async () => null };
const agent = { kind: 'agent', hostId: 'h1', id: 'a1', key: 'h1:a1' };

test('refreshes the exact host agent, scans older pages and writes only bounded outline metadata', async () => {
  const calls = [], writes = [];
  const handle = { refresh: async () => calls.push('refresh'), metadata: null, timeline: { refetch: async options => {
    calls.push(options ? 'before' : 'tail');
    return options ? { epoch: 'e', entries: [{ timestamp: 'at', seqStart: 2, item: { type: 'assistant_message', messageId: 'reply', text: '# Heading\n' + 'body'.repeat(300) } }], hasOlder: false, startCursor: null, error: null } : { epoch: 'e', entries: [{ timestamp: 'new', seqStart: 4, item: { type: 'assistant_message', text: 'short' } }], hasOlder: true, startCursor: { epoch: 'e', seq: 3 }, error: null };
  } }, setMetadata: async patch => writes.push(patch) };
  const getClient = serverId => { calls.push(serverId); return { agents: { ref: id => { calls.push(id); return handle; } } }; };
  const result = await model.syncOutline([{ serverId: 'h2' }, { serverId: 'h1' }], agent, getClient, () => 'updated');
  assert.deepEqual(calls, ['h1', 'a1', 'refresh', 'tail', 'before']);
  assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0]), ['clearChatOutline']);
  assert.equal(writes[0].clearChatOutline.replyId, 'reply'); assert.equal(writes[0].clearChatOutline.at, 'at');
  assert.deepEqual(writes[0].clearChatOutline.headings, [{ text: 'Heading', level: 1, offset: 0 }]);
  assert.ok(!JSON.stringify(writes).includes('bodybody')); assert.deepEqual(result, writes[0].clearChatOutline);
});

test('never calls another host when no exact mapping exists', async () => {
  let calls = 0;
  assert.equal(await model.syncOutline([{ serverId: 'other' }], agent, () => { calls++; throw Error('wrong host'); }), null);
  assert.equal(calls, 0);
});
