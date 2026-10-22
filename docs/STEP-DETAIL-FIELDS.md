# Reported step fields

This audit targets Paseo v0.12.0 (commit `cafe4b01c8522ff39560241c5deb01427dc8dc5b`),
the repository's three provider fixtures, and two fresh read-only projected
captures. Availability is per tool call: a provider name does not imply that
all its tools supply the same fields.

| Source | Duration | Process exit code | Separate stderr |
| --- | --- | --- | --- |
| Claude | No duration on shell calls. Conditional on other tools: Glob and WebFetch retain `detail.durationMs`; WebSearch retains `detail.durationSeconds`. None occurs in the captured shell failure. [Schema](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/protocol/src/agent-types.ts#L215-L268), [conversion](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/tool-call-detail-primitives.ts#L889-L920), [fetch conversion](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/tool-call-detail-primitives.ts#L955-L974). | Available when `detail.exitCode` survives conversion. In the captured failure it is instead an explicit `Exit code 1` header in `error.content`, inside a failed `tool_result` envelope. [Fixture](../test/fixtures/real-shell-details.json#L9-L19), [shell conversion](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/tool-call-detail-primitives.ts#L183-L211). | Not separate in the shell projection or captured failure. Its error text survives in `error.content`; the plugin displays it as Error without claiming it is stderr. [Failure mapping](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/claude/agent.ts#L5571-L5601), [discarded normal output on error](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/claude/agent.ts#L5638-L5645). |
| Codex | Not retained by the native command-execution mapping or shell schema; absent from the existing shell fixture. [Mapper](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/codex/tool-call-mapper.ts#L679-L706), [parser](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/codex/tool-call-detail-parser.ts#L83-L119). | Yes: native `exitCode` becomes `detail.exitCode`, including zero. [Fixture](../test/fixtures/codex-session.json#L23-L35), [mapper](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/codex/tool-call-mapper.ts#L688-L695). | No separate stream in the native shell projection: `aggregatedOutput` becomes `detail.output`. [Mapper](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/codex/tool-call-mapper.ts#L679-L695). |
| Hermes (ACP) | No duration in the standard ACP shell projection, nor in the new captured listing. [ACP conversion](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/acp-agent.ts#L3895-L3907). | Yes when ACP supplies `detail.exitCode`; otherwise the captured `detail.output` has a complete `terminal result` envelope ending with `- **exit_code:** 0`. Existing failed-shell capture reports 1. [New capture](../test/fixtures/real-shell-details.json#L35-L50), [failure capture](../test/fixtures/real-hermes-errors.json#L23-L39), [ACP conversion](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/acp-agent.ts#L3895-L3907). | No separate stream in these captures or the ACP shell conversion. The merged `detail.output` remains Output. [New capture](../test/fixtures/real-shell-details.json#L40-L44), [ACP conversion](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/agent/providers/acp-agent.ts#L3895-L3907). |

The shell wire schema also contains only `command`, `cwd`, `output` and
`exitCode`: [messages.ts:531](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/protocol/src/messages.ts#L531-L539).
Search/fetch duration support is conditional on their typed output schemas;
it is not a universal lifecycle timer. Unknown tools can retain explicit
structured results, but their presence must be checked on the individual call.

## Adapter and display rules

- Read valid explicit `durationMs` or `durationSeconds` and process exit-code
  fields first. Zero remains a valid reported value. HTTP `code` is never a
  process exit code.
- For shell tools only, recover an integer from a complete terminal-result
  envelope or the leading `Exit code N` header in a failed Claude `tool_result`.
  A command, status, arbitrary output line or timestamp cannot provide a code.
  Structured codes take precedence over text envelopes.
- Preserve the full Claude `error.content` for display and Copy error. Failure
  output has not been reconstructed or relabeled as stderr.
- If a shell result explicitly retains string `stdout` or `stderr` at the
  detail root or inside `output`/`result`, show each as its own selectable,
  virtualized section and Copy action. Empty strings remain copyable. Preserve
  the complete structured Output and its Copy action as well. These explicit
  stream cases are compatibility tests, not claims about the captured providers.
- Omit unavailable duration, exit code and stderr. No elapsed time is calculated
  from timeline timestamps, sequence ranges, status or surrounding messages.

## Captures and before/after evidence

`test/fixtures/real-shell-details.json` preserves one failed Claude shell entry
and one completed Hermes listing entry. They were obtained through the CLI's
read-only `logs` operation against an isolated test daemon. Since v0.12.0 logs
formats text even with `--json`, a temporary observer retained the existing
`fetch_agent_timeline_response` payload used by that same operation. The
projection was `projected`; no daemon, session or plugin settings were changed.
Only sanitized entries are committed. A recursive comparison confirmed identical
keys, nesting, array lengths and value types; content, paths, identities and
dates are fictional replacements. Codex evidence uses the existing synthetic
fixture and tagged upstream mapper, not a newly captured Codex session.

| Sample | Before | After |
| --- | --- | --- |
| Captured Claude failure | Status failed; no exit-code field or error section; Output says no output was reported. | Exit code 1 and the complete Error text are visible; Copy error includes the header and error line. Output remains absent because upstream omitted it. Duration and separate stderr remain omitted. |
| Captured Hermes listing | Exit code appears only inside the terminal-result text. | Exit code 0 also appears as separate metadata; the full result remains copyable. Duration and separate stderr remain omitted. |
| Existing Codex shell fixture | Typed exit code 0 is already supported. | Exit code 0 remains visible; absent duration and stderr stay omitted. |

`test/step-detail-fields.test.cjs` replays the registered transformer, schema,
renderer and details on web, iOS and Android at 1440, 1024, 820 and 390px. It
also checks duration on search/fetch, explicit stream whitespace, empty streams,
copy rejection, envelope validation, structured-code precedence, fixture
immutability and omission of fabricated values. Native primitives are stubbed;
these checks do not replace physical-device validation.

For Chrome layout and real clipboard checks, install the documented showcase
dependencies and run `node scripts/replay-step-details.cjs --fields-only` with
`KANBAN_TMP` set. This builds the preview in memory, uses an available debugging
port in 9444–9499, checks all four widths with the three provider samples plus
an explicit-stream compatibility sample, and stores its report/screenshots in
the task's temporary directory. The existing full replay remains available
without the flag.

The complete browser replay also has a known rotation/scroll restoration
timeout at `scripts/replay-step-details.cjs:231` in the original runner. The
same timeout was reproduced against the unmodified starting revision using
the original runner and original component sources. It is separate from the
field checks above and remains for review; this change does not claim a passing
full layout replay or physical-device acceptance.

Recorded implementation checks: the starting revision passed 957 existing tests.
The final 22 field regressions produced 19 failures and 3 passes against the
starting component sources, then all 22 passed with this fix. The full suite
passed 979 tests before integration and 1,010 after rebasing onto the latest
feature branch, including its agent-delivery regressions. Main and showcase
TypeScript checks passed. Client and server entrypoints also bundle in memory
with external runtime dependencies, matching the host's supplied SDK model.
