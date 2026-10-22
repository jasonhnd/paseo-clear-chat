# Conversation performance measurements

Measure an existing, scrollable conversation at `https://app.paseo.sh` using the
installed **Google Chrome**. The daemon address is required on every invocation.
The script opens a temporary connection setup tab, then a **new tab for every
sample**, closes each sample tab, and reports the median of N successful samples.
It does not submit messages, change plugins, or record conversation text.

## Setup

```bash
npm install
node scripts/perf/measure.cjs --help
```

`playwright-core` is a development dependency. No Playwright browser download is
needed: the launcher uses `channel: "chrome"`, with no browser fallback. Chrome
must already be installed. Browser profiles are temporary; your normal Chrome
profile is not used. Local network access is granted to `https://app.paseo.sh` in
the temporary contexts so it can connect to the supplied daemon.

This connection flow supports direct daemons without a password. It uses Paseo's
Direct connection dialog and browser host registry. Those integration points and
the default content selector were smoke-tested with Paseo Web 0.12.0. A connection,
readiness, selector, or sampling failure exits nonzero without a summary; samples
are never silently discarded or replaced with zero readings.

## Run

Open the intended daemon in Paseo and choose a **long, completed conversation**.
Get its agent ID from the `/agent/<id>` deep link, or the `workspace-tab-agent_<id>`
element's `data-testid` in Chrome DevTools. Copy only the ID, not conversation
content. Avoid an actively streaming conversation for repeatable measurements.

Set `DAEMON_ORIGIN`, `AGENT_ID`, and `KANBAN_TMP` to the chosen daemon, agent ID,
and an untracked local results directory, respectively. Then run:

```bash
: "${DAEMON_ORIGIN:?Set the daemon origin}"
: "${AGENT_ID:?Set the existing agent ID}"
: "${KANBAN_TMP:?Set an untracked temporary results directory}"
mkdir -p "$KANBAN_TMP"
export TMPDIR="$KANBAN_TMP"

node scripts/perf/measure.cjs \
  --daemon "$DAEMON_ORIGIN" \
  --agent "$AGENT_ID" \
  --label current-state \
  --runs 3 \
  --output "$KANBAN_TMP/current-state"
```

The script writes `current-state.json` (metadata, per-run readings, and medians)
and `current-state.md` (a Markdown table). The same table is printed to stdout;
progress goes to stderr. Reusing an output prefix replaces its previous reports.
Reports include the daemon address and agent ID, but no prompts, replies, tool
payloads, screenshots, or traces. Keep results outside tracked files; do not
commit benchmark readings or browser state.

For a smoke test, use `--runs 1 --headless` with the **current** plugin state.
Check that both files exist and that `firstScreenMs`, `heapUsedBytes`, `frameCount`,
`scrollDurationMs`, and `movedPixels` are positive finite readings. A zero long-frame
count or dropped-frame ratio is valid. This only checks the measurement pipeline.

## Plugin configurations

The label is an operator assertion, not an inspected or enforced plugin setting.
An operator prepares the installed/enabled or absent/disabled state separately.
Run the script once per prepared state, for example with
`--label plugin-installed --output "$KANBAN_TMP/plugin-installed"` and
`--label no-plugin --output "$KANBAN_TMP/no-plugin"`. The script never installs,
enables, disables, updates, or removes a plugin. Do not toggle plugins on a shared
test daemon without its owner's authorization.

Use the same daemon, conversation, viewport, Chrome version/mode, refresh budget,
and durations for both labels. Keep the measurement tab foregrounded and avoid
other work on the machine. For later formal comparisons, alternate configuration
order and retain all raw samples alongside the medians. A single current-state
smoke is not a plugin comparison.

## Metric definitions

| JSON field | Definition |
| --- | --- |
| `firstScreenMs` | Milliseconds from document navigation time origin to the next rAF after a nonempty conversation row is observed intersecting the viewport. This gives the row a paint opportunity. It includes app load, daemon reconnect, history loading, and rendering. It is a content-readiness proxy, not browser FCP or proof that the entire history has loaded. |
| `longFrames` | Number of sampled rAF intervals at least 50 ms during scrolling. This is a frame-gap count, not the Long Animation Frames API or a long-task count. |
| `delayedFrames` | Number of intervals greater than 1.5 times the configured refresh budget. |
| `droppedFrames` | Estimated missed refresh slots: sum of `max(0, round(interval / (1000 / fps)) - 1)`. |
| `droppedFrameRatio` | Estimated dropped slots divided by observed intervals plus dropped slots. JSON uses a fraction; Markdown displays a percentage. This measures main-thread rAF delays, not compositor/GPU frame delivery. |
| `heapUsedBytes` | CDP `Runtime.getHeapUsage.usedSize` after `HeapProfiler.collectGarbage`, after scroll timing completes. Retained JS heap only; not total process, DOM, GPU, or system memory. Markdown converts bytes to MiB. |
| `frameCount`, `maxFrameMs`, `scrollDurationMs` | Number, maximum gap, and total duration of observed rAF intervals. |
| `movedPixels`, `viewportHeight`, `initialScrollHeight`, `finalScrollHeight` | Scroll movement and geometry for checking that the intended conversation actually scrolled. |

After content readiness, the script waits `settleMs`, finds the nearest scrollable
ancestor of a visible conversation row, moves to the bottom, waits `settleMs`
again, and scrolls at two viewport heights per second. It reverses at either end
for `scrollMs`. History pagination and rendering triggered by this movement are
included. Heap collection runs outside both timing windows. A hidden tab, missing
content marker, non-scrollable conversation, replaced scroller, or no movement
fails the sample. GC overhead is excluded from the first-screen and scrolling
metrics.

Each summary field is the median of that field's per-run values, including each
run's own dropped-frame ratio. Even sample counts average the two middle values;
median counts can therefore be fractional. There are no pooled ratios or implied
improvements. The Chrome process and measurement context stay open across samples,
so later samples may reuse HTTP cache; every sample gets a new document and JS
heap. Service workers are blocked. This measures new-tab opens, not cold browser
launches. Use the same cache procedure for both configurations.

## Controls and selectors

| Option | Default | Purpose |
| --- | --- | --- |
| `--runs` | `3` | Successful samples required, from 1 to 100. |
| `--scroll-ms` | `5000` | Scroll sampling time. |
| `--settle-ms` | `1000` | Delay at each of the two settling points. |
| `--timeout-ms` | `60000` | Timeout for navigation, connection, and content readiness. Scroll sampling has an additional timeout of this length beyond `scrollMs`. |
| `--fps` | `60` | Refresh rate used to estimate missed slots; set it to the test display's rate. |
| `--width`, `--height` | `1440`, `900` | CSS viewport dimensions. |
| `--headless` | off | Use installed Chrome's headless mode; record and keep the mode consistent. |
| `--trace` | off | Save a CDP trace for each scroll window as `<prefix>.run-N.trace.json`. |
| `--ready-selector` | `[data-testid="agent-chat-scroll"] [data-message-id]` | Nonempty visible message row marker, scoped to the conversation. |
| `--scroll-selector` | automatic | Optional CSS selector matching exactly one conversation scroller. |

If a Paseo update changes its markup, inspect the conversation in Chrome and pass
selector overrides. Use a real message marker shared by both configurations, not
a sidebar title, composer, loading placeholder, or plugin-specific card. An
explicit scroll selector must identify the conversation's scrolling element.

For diagnosis, add `--trace` and place the output prefix under `$KANBAN_TMP`.
Open the resulting trace in Chrome DevTools Performance to inspect JavaScript
stacks and forced layouts. Tracing excludes navigation, settling and heap
collection, and enables CPU samples and timeline events without screenshots,
DOM snapshots or network bodies. Traces may still contain private URLs: delete
them after analysis and never commit or attach them. Run comparison measurements
without tracing, since profiling adds overhead.

## Auditing reply-duration timeline reads

Reply duration uses a separate canonical timeline request. A first-screen median
alone does not show its recurring network cost: the request can overlap app
startup, and another request can occur when the agent's status or update time
changes. Audit those reads separately from the ordinary measurement runs.

Use the same sanitized long history and isolated daemon for both revisions.
Record the canonical entry count, tool-call count and serialized response size;
tool-call count alone does not describe the amount of history transferred.
Prepare each plugin revision only on that isolated daemon. Keep shared test
daemons unchanged, and keep temporary homes, provider history, browser profiles
and reports under the chosen temporary results directory. Stop the isolated
daemon and remove those files when finished.

For network diagnosis, register Chrome WebSocket frame listeners before
navigation. Match outgoing `fetch_agent_timeline_request` messages with
`projection: "canonical"` to incoming `fetch_agent_timeline_response` messages
by `payload.requestId`, keeping a separate pending map for each socket. Paseo's
JSON envelope places these messages under `message`. Retain only aggregates:

| Reading | Definition |
| --- | --- |
| Count | Matching requests in each lifecycle phase, including unfinished requests. |
| Frame elapsed time | Monotonic time between the observer receiving the outgoing request frame and its matching incoming response frame. Inspector delivery and observer scheduling affect this reading; it is not the API Promise duration. |
| Response bytes | UTF-8 byte length of the complete incoming JSON envelope. This is serialized application data, not compressed network bytes. |
| Window | Request direction and limit, response entry count and completeness flags. `tail` with `limit: 0` requests all history. |

When a latency threshold applies to the API, also time the actual
`timeline.refetch` Promise in a temporary diagnostic build. Record duration
derivation separately after the Promise resolves. Frame timing alone cannot
establish that the decoded API result meets that threshold, and inspector lag
can even make it exceed the in-page API duration. Keep this diagnostic
build out of the ordinary first-screen, scroll and heap samples.

Observe opening, entering `running`, further updates while running, returning
to `idle`, and further idle updates. Repeat complete cycles to distinguish a
shared read from one request per mounted reply. A controlled status replay must
be identified as such: replaying metadata against a fixed history measures
invalidation and transfer cost, while a real appended turn also measures history
growth. Use valid subscription metadata from the host's own update events;
fabricated directory events may be silently ignored. Do not submit real model
prompts merely to obtain timing samples.

Do not store prompts, reply text, tool output, request IDs or agent snapshots in
the diagnostic report. Release parsed response bodies after collecting their
size and entry count. Keep instrumented runs separate from the standard
first-screen, scroll and heap comparison, since frame listeners and JSON parsing
add overhead. Heap comparisons still require a fresh tab for every sample.

Report per-run first-screen values, heap readings, total long-frame counts and
the worst frame interval as well as medians. This script counts intervals
**at least** 50 ms; a check defined as **greater than** 50 ms must distinguish an
exactly 50 ms boundary sample. A zero median can still contain a nonzero outlier.
Keep numeric results in the local report or review handoff, together with the
revision hashes, replay method and limitations; do not commit raw captures.

## Method reference and limits

The public [Better Paseo performance description](https://github.com/RoundRedDot/better-paseo/blob/main/README.md#performance)
and [memory description](https://github.com/RoundRedDot/better-paseo/blob/main/README.md#memory-comparison)
(read on 2026-10-21) informed the repeated-sample medians, fixed browser conditions,
and forced-GC heap readings after timing. Only those descriptions were consulted;
this script was independently written. Their published benchmark uses controlled
replays and additional profiling. This script observes an existing conversation
in the hosted web app, so its first-screen and scroll readings are a different
protocol and cannot be compared directly with their published numbers.

Hosted app changes, daemon load, history size, network/cache state, system load,
display refresh rate, and browser scheduling affect results. Small differences
need repeated controlled runs. This utility does not judge plugin performance or
run a formal comparison automatically.

## Browser-free tests

```bash
node --test test/perf.test.cjs
npm test
npm run typecheck
```

The performance tests cover required/invalid arguments, defaults and overrides,
frame arithmetic, odd/even medians, per-run aggregation, Markdown formatting, and
fresh-tab lifecycle including failure cleanup. They launch no browser and make no
daemon connection.
