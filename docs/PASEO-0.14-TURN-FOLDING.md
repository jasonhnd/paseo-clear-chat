# Paseo 0.14 turn folding compatibility

Issue #74 is blocked on a supported host signal. No change to Clear Chat's
folding behavior is included in this investigation.

The [Paseo 0.14.0 client contract](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/plugin/src/client/contracts.ts)
passes a timeline transformer only the source `item` and its `phase`. A timeline
renderer receives the plugin item, host, agent ID and timestamp, but no Chat
display mode or host turn-fold/expansion state. The public
[`useSettings`](https://github.com/getpaseo/paseo/blob/v0.14.0/public-docs/plugins/reference.md)
API reads a plugin's own registered settings; it does not expose the app's Chat
display setting. The three host modes and their storage are defined in the
[app's internal settings](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/app/src/hooks/use-settings/storage.ts).

The 0.14.0 host [projects plugin timeline items before calculating its display](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/app/src/agent-stream/presentation.ts).
Its [turn-fold model](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/app/src/agent-stream/turn-collapse/model.ts)
uses host row kinds to identify triggers, work and the final reply. Clear Chat
replaces those source rows with plugin items, so the interaction cannot be
assumed from the selected display mode alone. This is a source inspection, not
a claim that double folding or lost content has been reproduced.

A supported interface needs to convey enough host presentation context for the
specific turn, including whether the host owns its fold and its expansion state,
and notify the plugin when that context changes. The behavior of plugin-replaced
rows within the host fold also needs a defined contract. Reading internal app
storage, inferring state from the DOM or patching Paseo would not meet the issue's
supported-interface requirement. Once a contract exists, implementation must
retain the existing 0.13 behavior when the signal is unavailable and verify the
full acceptance matrix against the real host.

Not verified by this investigation: real 0.14.0 host UI, the three display modes
and transitions, completed or active turns, failures, approvals, expansion,
reading position, accessibility, and 0.13.2 host compatibility. No host UI
evidence or new behavior-specific regression tests are claimed.
