'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractHeadings } = require('../client/outline-model.ts');

for (const [source, expected] of [
  ['### C#', 'C#'],
  ['## F###  ', 'F###'],
  ['# hash#\t', 'hash#'],
  ['### title ###', 'title'],
  ['## title\t##  \t', 'title'],
  ['# title # suffix', 'title # suffix'],
  ['# title ###x', 'title ###x'],
  ['# plain title  ', 'plain title'],
]) {
  test(`heading suffix: ${JSON.stringify(source)}`, () => {
    assert.deepEqual(extractHeadings(source), [{ text: expected, level: source.indexOf(' '), offset: 0 }]);
  });
}

test('closing-only and empty headings stay excluded', () => {
  assert.deepEqual(extractHeadings('# ###\n##   \t\n###\n'), []);
});

test('offsets and fenced headings remain intact around hash suffixes', () => {
  const input = '😀 intro\r\n  ### C#  \r\n~~~js\n# hidden#\n~~~\n```\n## hidden ###\n```\n # title ###\n';
  assert.deepEqual(extractHeadings(input), [
    { text: 'C#', level: 3, offset: input.indexOf('### C#') },
    { text: 'title', level: 1, offset: input.indexOf('# title') },
  ]);
});
