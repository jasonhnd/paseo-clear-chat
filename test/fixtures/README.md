# Tool timeline replay fixtures

These are handwritten synthetic sessions in the shape delivered to a plugin.
They contain fictional tasks, relative project paths, example.org URLs and
sample model labels. No original session data was used.

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
