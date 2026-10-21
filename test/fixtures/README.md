# Tool timeline replay fixtures

The `real-*.json` fixtures are sanitized captures from Paseo's projected timeline
API. They are the primary replay samples. The other fixtures are handwritten
synthetic sessions that provide additional coverage. Every sample contains
fictional content, sample identifiers, neutral paths and example.org URLs.

## Captured structures

- `real-hermes-session.json` contains six tool calls and the prompt and final
  reply. Paseo normalizes the tool names to `execute`, `read`, `search`, `fetch`
  and `other`. The original tool identity and argument appear in
  `metadata.title`, and sometimes in a detail field such as `filePath` or `url`.
- `real-claude-session.json` contains 28 tool calls, including shell calls and
  MCP calls with nested input and output objects. This provider does not attach
  the Hermes metadata object.

Both captures used `fetchAgentTimeline(agentId, { direction: "tail", limit: 0,
projection: "projected" })`; both returned `hasOlder: false` and
`hasNewer: false`. Fixtures retain each `entry.item` with the exact original
keys, nesting, array lengths, value types, detail tags and metadata shapes.
Tool namespaces and all message content, identifiers, paths and URLs were
replaced. No source agent identifiers or connection details are stored here.
The original and sanitized item structures were compared before the captures
were committed. Raw captures are temporary and are never committed.

## Synthetic coverage

The handwritten samples contain no original session data:

- Hermes includes `skill_view`, Search, Fetch and an Other call (`memory` with
  `action: add`), along with failed, canceled and empty-output calls.
- Claude uses normalized Read, Glob, Edit, Write, Bash, WebSearch, WebFetch and
  Task details, a plan and an independent todo timeline item.
- Codex uses normalized command, file, patch, search and delegation details. Its
  explicit `web_search` detail also covers hosts that send that type directly.

The pinned SDK represents web search as `search` with `toolName: web_search`,
and todo as an independent timeline item. Both these shapes and explicit
`web_search`/`todo` tool detail tags are covered by the renderer tests.

Run `node --test test/tool-replay.test.cjs`. Each item passes through the actual
registered transformer, schema, live renderer and card body, with host primitives,
animation and syntax painting supplied by a small test harness. The replay opens
completed cards before checking that each body contains visible text. These are
component replays, not a live Paseo integration test.

| Sample | Tool calls | Cards including todo | Empty cards | Generic calls | Generic rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hermes | 20 | 21 | 0 | 1 | 5.0% |
| Claude | 12 | 13 | 0 | 0 | 0.0% |
| Codex | 12 | 13 | 0 | 0 | 0.0% |

Generic rate counts actual generic card bodies divided by tool calls. Independent
todo items are checked for empty rendering but do not inflate the denominator.
Hermes memory still counts as generic even though its summary says `memory · add`.
