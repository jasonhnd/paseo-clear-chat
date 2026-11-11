const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localDayBounds, boardSection, lastActivityTime } = require('../client/agent-board-model.ts');

test('board uses local midnight and separates running from today and older activity', () => {
  const oldTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const bounds = localDayBounds(Date.parse('2026-03-08T19:00:00Z'));
    assert.equal(new Date(bounds.start).toISOString(), '2026-03-08T08:00:00.000Z');
    assert.equal(new Date(bounds.end).toISOString(), '2026-03-09T07:00:00.000Z');
    const agent = { status: 'idle', lastActivityAt: '2026-03-08T07:59:59.999Z', updatedAt: '2026-03-08T07:59:59.999Z' };
    assert.equal(boardSection(agent, bounds), null);
    assert.equal(boardSection({ ...agent, status: 'running' }, bounds), 'running');
    assert.equal(boardSection({ ...agent, updatedAt: '2026-03-08T08:00:00.000Z' }, bounds), null);
    assert.equal(boardSection({ ...agent, lastActivityAt: '2026-03-08T08:00:00.000Z' }, bounds), 'finished');
    assert.equal(boardSection({ ...agent, lastActivityAt: '2026-03-08T08:00:00.000Z', updatedAt: '2026-03-09T07:00:00.000Z' }, bounds), 'finished');
    assert.equal(boardSection({ ...agent, lastActivityAt: '2026-03-09T07:00:00.000Z' }, bounds), null);
    assert.equal(lastActivityTime({ ...agent, updatedAt: 'invalid' }), Date.parse(agent.lastActivityAt));
  } finally {
    if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
  }
});


test('pending summary accepts only valid positive metadata', () => {
  const { pendingSummary } = require('../client/agent-board-model.ts');
  assert.deepEqual(pendingSummary({ clearChat: { pending: 2, total: 3, updatedAt: '2026-11-11T12:00:00Z' } }), { pending: 2, total: 3, updatedAt: '2026-11-11T12:00:00Z', time: Date.parse('2026-11-11T12:00:00Z') });
  for (const value of [null, {}, { clearChat: { pending: 0, total: 3, updatedAt: '2026-11-11T12:00:00Z' } }, { clearChat: { pending: 4, total: 3, updatedAt: '2026-11-11T12:00:00Z' } }, { clearChat: { pending: 1, total: 3, updatedAt: 'bad' } }]) assert.equal(pendingSummary(value), null);
});
