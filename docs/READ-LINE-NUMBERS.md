# Read detail line numbers

Read step details use `client/read-output.ts` as the single parser for content,
clipboard text and source line numbers. Recognized Hermes envelopes lose their
header and outer code fence; each `N|` prefix supplies that line's original file
number. An offset read can therefore begin at 50 rather than being renumbered.
When the projected content has no envelope or line prefixes, numbering begins
at 1. Invocation offset fields do not override this fallback: omitted provider
information cannot be reconstructed reliably.

Each source line is a virtual list item containing a nonselectable gutter and
selectable content. Both share a row so a wrapped or blank source line reserves
the same height for its number. Read lists render batches of 32 lines; other
step output retains the existing four-chunk batch. Copy output uses the complete
parsed content, independently of mounted cells. Web gutters also set
`userSelect: "none"`; native gutters use `selectable={false}`.

## Fixture coverage

- Hermes: `real-hermes-hover.json` is a sanitized captured projected item with
  numbered envelope content. `hermes-offset-read.json` constructs an offset/limit
  variant of that captured format, with source lines 50 through 52. It is not an
  additional capture. `real-hermes-session.json` covers projected plain content.
- Claude: `real-claude-turn-timing.json` supplies its actual nested `entry.item`
  read projection. The host has already removed provider formatting, so its
  plain content starts at 1.
- Codex: the existing `codex-session.json` read projection supplies plain content
  and starts at 1. This fixture is synthetic; a captured Codex read remains a
  host acceptance coverage gap.

`test/read-line-numbers.test.cjs` sends individual projected tool items through
the registered transformer, schema and renderer on web, iOS and Android. It
checks copied content, nonselectable gutters, preserved newlines, literal pipe
content, and line mapping in a 10,000-line read with a wrapped middle line.
Native primitives are mocked; physical device behavior remains a host check.

## Offline browser replay

After `npm ci --include=dev` and `npm ci --prefix .showcase --include=dev`, run:

```sh
TMPDIR="$KANBAN_TMP" node scripts/replay-read-lines.cjs
```

Use an absolute task directory for `KANBAN_TMP`. The replay bundles both
production entry points in memory, then runs the real detail component in
headless Chrome at 1440, 1024, 820 and 390px. It measures gutter/content alignment,
wrapping and horizontal bounds at the beginning, middle and end of 10,000 lines;
checks a bounded mounted window; and verifies browser text selection and the
clipboard independently. Reports and screenshots stay in the task directory.
Chrome uses a free debugging port in 9444 through 9499. No host is contacted.
