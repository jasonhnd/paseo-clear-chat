'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('board hook calls use the SDK types without double casts', () => {
  const source = readFileSync(join(__dirname, '../client/components/agent-board.tsx'), 'utf8');
  assert.doesNotMatch(source, /as\s+unknown\s+as/);
  assert.doesNotMatch(source, /type\s+BoardHooks\s*=/);
});
