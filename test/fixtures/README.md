# Tool timeline replay fixtures

The `real-*.json` fixtures are sanitized captures from Paseo's projected timeline
API. They are the primary replay samples. The other fixtures are handwritten
synthetic sessions that provide additional coverage. Every sample contains
fictional content, sample identifiers, neutral paths and URLs on example domains.

## Captured structures

- `real-hermes-session.json` contains six tool calls and the prompt and final
  reply. Paseo normalizes the tool names to `execute`, `read`, `search`, `fetch`
  and `other`. The original tool identity and argument appear in
  `metadata.title`, and sometimes in a detail field such as `filePath` or `url`.
  Discovery labels retain the provider's `Searching tools ·` display prefix,
  which is removed from the query and summary after validating the source tool.
- `real-claude-session.json` contains 28 tool calls, including shell calls and
  MCP calls with nested input and output objects. This provider does not attach
  the Hermes metadata object.
- `real-claude-wrapup.json` isolates the wrap-up item from that same 28-call
  session, checked against the provider's local session as well as the projected
  timeline. Its required tool name, `mcp__ccd_turn__wrap_up`, is preserved exactly.
  The item is a `tool_call` with `detail.type: unknown`, an object `input` holding
  `recap`, `ask`, two `actions` with `label` and `message`, and boolean `blocked`.
  The result retains its nested `output.output` shape. All prose and the call ID
  are fictional. Key, nesting, array-length and value-type differences are zero.
- `real-hermes-approvals.json` retains a seven-item projected timeline with two
  edits and two completed approval records. Each approval is a `tool_call` with
  `detail: { type: "unknown", input: null, output: null }`; its name, call ID and
  sole metadata title match an `edit-approval-*` identifier. Each follows an edit,
  but neither contains a reference to that edit. The single-item transformer
  therefore renders a standalone approval status instead of guessing a link.
  All content, paths and identifiers are fictional; item keys, nesting, array
  lengths, value types, detail tags and metadata shapes match the capture.
  `test/tool-approval.test.cjs` replays both records on web, iOS and Android and
  derives pending and denied variants as additional synthetic coverage.

The full-timeline captures used `fetchAgentTimeline(agentId, { direction: "tail", limit: 0,
projection: "projected" })`; each returned `hasOlder: false` and
`hasNewer: false`. Fixtures retain each `entry.item` with the exact original
keys, nesting, array lengths, value types, detail tags and metadata shapes.
Tool namespaces and all message content, identifiers, paths and URLs were
replaced. No source agent identifiers or connection details are stored here.
The original and sanitized item structures were compared before the captures
were committed. Raw captures are temporary and are never committed.

## Captured assistant links

`real-assistant-links.json` contains two sanitized `assistant_message` items
from projected Hermes timelines. Both retain exactly `type`, `text` and
`messageId`. The first reply is a three-item ordered list: a Markdown link, a
bare URL immediately after a fullwidth colon, and a note ending in an
ideographic full stop. The second has two Markdown images followed by a bare
URL immediately after a fullwidth colon. Newlines, Markdown delimiters and
surrounding punctuation are preserved. Prose, message IDs and URLs are
fictional; Unicode punctuation is escaped in JSON.

The running host used the default assistant Markdown preference. These items
reach `omp-enhanced-assistant`, `omp-assistant`, `LiveAssistantRenderer` and
`MarkdownView`, whose custom parser performs autolinking. Its old word-boundary
check classified fullwidth punctuation as a word character, skipping these
URLs. The earlier reply-link tests used English prose with a space before the
bare URL, so they did not exercise this boundary. `test/reply-links.test.cjs`
replays both sanitized items through the registered transformer and real
renderer, then presses each bare link and checks the platform opener.

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

## Replay results

The original Hermes and Claude replays enforce zero empty cards and a generic-call rate of at most
5%. They also check replies through the real Markdown renderer. Claude includes
one explicit `wrap_up` tool: it counts as a tool call and renders as an expanded
final reply outside the 27 tool cards. All seven assistant/final replies in that
capture remain visible; Hermes has one visible final assistant reply.

| Real sample | Tool calls | Tool cards | Empty cards | Generic calls | Generic rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hermes | 6 | 6 | 0 | 0 | 0.0% |
| Claude | 28 | 27 | 0 | 0 | 0.0% |

The synthetic samples intentionally include generic tools for fallback coverage.
They assert their expected fallback counts and zero empty cards, while the real
captures supply the usage budget:

| Synthetic sample | Tool calls | Cards including todo | Empty cards | Generic calls | Generic rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hermes | 20 | 21 | 0 | 3 | 15.0% |
| Claude | 12 | 13 | 0 | 1 | 8.3% |
| Codex | 12 | 13 | 0 | 1 | 8.3% |

Generic rate counts calls rendered as plain text, unknown cards or fallback
bodies divided by tool calls. Each call counts at most once. Independent todo
items and assistant replies do not inflate the denominator. Hermes memory still
counts as generic even though its summary says `memory · add`. Tool discovery
uses a dedicated query-and-results body and counts as typed rendering.

`test/tool-real-payload.test.cjs` separately checks the captured `skill_view`,
`tool_search`, `web_search`, `terminal` and `search_files` cases in both collapsed
and expanded states. It also covers source-prefix validation, literal colon text,
canonical detail precedence, discovery output folding and the captured wrap-up
reply's structured layout. `test/tool-wrapup.test.cjs` exercises the isolated
item through the registered transformer, schema and real Markdown renderer on
web, iOS and Android. It requires the card header, complete recap, question,
lettered labels, option messages and boolean blocked alert, with no raw JSON or
tool disclosure. Saved collapsed choices and output limits cannot hide a reply.
Legacy JSON strings and unfamiliar-field fallbacks remain covered separately.
