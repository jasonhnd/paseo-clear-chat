# k1.1: duplicate sheets during Explorer handoff

## Cause and repair

The desktop selection and the per-step overlay session could both own the same
step. `StepDetailHostPanel` followed the viewport all the way to `sheet`, while
`useStepDetailSession` let a replacement compact timeline row reclaim the hosted
reading state as an open overlay. During the handoff, an Explorer root still
mounted while its replacement row rendered could therefore create a second
visible Modal. Hiding Explorer does not hide a portalled Modal. At a 390 × 900
viewport both sheets use the same half-height geometry: x=0, y=450, 390 × 450.

Explorer now stops rendering details below the shared 744px boundary. The
timeline claims the open session and releases the matching hosted selection,
retaining the same reading-state object. The transfer also handles a host that
retains its row instead of rebuilding it. No timers, polling, or artificial
render triggers were added; the existing session eviction microtasks remain.

`StepDetailPanel` and the breakpoint values need no change: the defect is which
root is allowed to render that panel, rather than its sheet geometry.

## Version evidence

This is plugin ownership logic already present in 0.12.0.1, not a dependency on
the SDK 0.13 migration:

- The reported plugin revision `7874ec1` itself pins SDK 0.12.0 and has version
  0.12.0.1. Its panel, host, session, breakpoints, and live renderer files are
  identical to the `origin/feat/v0` baseline used here.
- The SDK migration on `origin/ib/cc-sdk-0.13` changes the host registration to
  `addAgentPanel` and receives `agentId` through `params`. It does not change
  this ownership, sheet rendering, or reclaim logic.
- Before the fix, the regression on the SDK 0.12 branch produced two panels for
  all three desktop-start paths on each of the web, iOS, and Android shims:
  nine failures. The tablet-start and phone-start controls passed: six passes.

Consequently a 0.12 host exposing the same overlapping owner lifetime can hit
the same defect. A 0.13 host change is not required by the plugin logic. This
work does not claim a new live acceptance run on an actual 0.12 or 0.13 host;
the precise scheduling of the reported real-host overlap was not traced here.

## Regression scope and results

The earlier harness unmounted the timeline and Explorer together, masking the
handoff window. It can now rebuild just the row, check while the existing
Explorer root is still mounted, then remove Explorer at the compact boundary.
The tests check exactly one panel and a 400px saved reading position at every
step, before and after owner cleanup, and verify dismissal.

Paths: 1440 → 820 → 390, 1440 → 390, 1180 → 820 → 390, with 820 → 390 and direct
390 controls; all run on web, iOS, and Android shims.

The focused browser replay uses the existing `/host-remount` shape, rebuilding
the timeline and removing Explorer below 744. It checks one visible and one
mounted panel, settled viewport bounds, and an exact 200px reading offset on
all five paths. All passed. At 390px every final panel measured x=0, y=450,
width=390, height=450. This single-commit browser host shape also passed before
the fix; the independently rendered owner handoff is covered by the failing
component regression, rather than overstated as a browser reproduction.

Validation:

```sh
node --test test/step-detail-panel.test.cjs test/step-detail-content.test.cjs test/step-detail-fields.test.cjs test/step-detail-back.test.cjs
npm run typecheck
INSTABOX_HEADLESS=1 CHROME_PATH=/usr/bin/chromium KANBAN_TMP="$PWD/.tmp/k11" node scripts/replay-step-details.cjs --resize-only
```

Targeted tests: 131 passed, zero failed. Typecheck passed. Browser replay: all
five paths passed. The full npm test suite was deliberately not run.
