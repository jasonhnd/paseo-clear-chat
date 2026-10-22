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
- `real-hermes-patch.json` isolates two completed edits from another real
  projected timeline. Each item has `name: edit`, `detail.type: edit`,
  `detail.filePath`, `detail.unifiedDiff`, `metadata.kind: edit`,
  `metadata.title`, a call ID, a status and a null error. Despite its name,
  `unifiedDiff` contains only a two-line success message. There is no input,
  patch text or old/new text in either item. A read-only canonical fetch returned
  identical items. The fixture preserves this missing-data condition instead of
  inventing patch content. Its regression tests require the original text and
  no change count; a red/green diff requires the provider to retain the actual
  patch or replacement text in the timeline.

All full-timeline captures used `fetchAgentTimeline(agentId, { direction: "tail", limit: 0,
projection: "projected" })`; all returned `hasOlder: false` and
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

Run `node --test test/edit-diff.test.cjs` for the captured Hermes patch fallback
and the synthetic red/green replacement and unified-diff cases. The two captured
edits cannot establish an addition or deletion count from the available data.

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

`real-hermes-errors.json` is a separate projected-timeline capture of two failed
Hermes calls: `read` with `detail.type: read` and `execute` with
`detail.type: shell`. Both retain `error: { message: string }`, their original
metadata shapes, and string content/output. The read failure reports a missing
file; the shell output retains the `terminal result` heading and Markdown bold
labels `**output:**` and `**exit_code:**`, reporting a missing directory and exit
code 1. A fresh read-only projected fetch confirmed this exact output envelope. All prose,
paths and call IDs are fictional. A recursive comparison against the temporary
capture confirmed identical keys, nesting, array lengths and value types.
`test/tool-errors.test.cjs` replays both without manually opening their cards.

## Captured reply footer structure

`real-hermes-reply-footer.json` retains an entire four-entry projected timeline:
user message, failed read, failed shell call, assistant reply. There is no
wrap-up tool in this capture. Entry fields, item fields, order, source sequence
ranges, collapsed lifecycle tags, array lengths and value types match the
read-only capture. All prose, paths, message IDs, call IDs, turn IDs and dates
are fictional. A recursive structure comparison reported zero differences.
`test/reply-footer.test.cjs` uses it to keep Copy available when a later item or
another conversation owns the global timeline tail. The existing isolated
Claude wrap-up capture supplies the separate final-tool-reply regression.

## Captured image listing

`real-hermes-image-listing.json` preserves three entries from a read-only
`projection: "projected"` timeline: a user message, an `execute` tool call with
`detail.type: "shell"`, and the assistant reply. The tool output keeps the
`terminal result` wrapper, Markdown output and exit-code fields, and `ls -la`
permissions, link counts, owner/group columns, sizes, dates and filenames. A
filename contains a space. The reply contains an absolute spaced path, a
relative spaced path and an HTTP(S) URL. All prose, identities, paths and dates
are neutral replacements. A recursive comparison of entry keys, nesting,
array lengths and value types reported zero differences before commit.
`test/image-output.test.cjs` checks that the listing produces no preview or
file read while the reply retains all three complete image sources.

`real-hermes-readme-images.json` isolates a projected `read` of a text README.
Its `detail.content` retains the read header, fenced block and 30 numbered lines,
including a Markdown image and an image path in prose. All content, paths,
identifiers and dates are fictional. Entry and item keys, nesting, array lengths
and value types match the read-only capture with zero structural differences.
`test/tool-image-policy.test.cjs` requires no previews or image RPCs for image
paths mentioned inside that text, in expanded and collapsed states on all three
platforms.

`real-hermes-image-path-reply.json` preserves a separate captured assistant
item with exactly `type`, `text` and `messageId`. Its two prose lines give an
absolute and a relative image address. All prose, paths and the identifier are
fictional; a recursive comparison confirmed zero key or value-type differences.
`test/image-output.test.cjs` replays both images on web, iOS and Android, alongside
the listing reply above and the captured Markdown images in
`real-assistant-links.json`.
