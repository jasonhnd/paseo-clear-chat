APPROVE

Scope: server/hermes-cc/catalog.ts, server/hermes-cc/transport.ts, server/hermes-cc/model-protocol.ts
HEAD: 678d52195b664b9dec006b238c6fb38cbf04c2c9
Base: 445183ef08e14f203bf18c3cad12c873a673030a
Judgment: independent Grok 4.6 source review of the embedded runtime diff only (no tests run here). Prior Grok 4.7 execution logs (full 1728/0fail/0skip, native 10/10, helper 7/7, tsc 0, original-bridge red exit 1) are supplied evidence, not this card’s runs.

Must
- None. Request/response correlation reuses the caller JSON-RPC id with no adapter-generated calls; native `session/set_model` is a CC-owned rewrite of the synthetic SDK option; errors leave confirmed `currentModelId` untouched; native `configOptions` are copied then appended; initialize/prompt/cwd/env/history/images are not rewritten; protocol is constructed per user transport with no module-load RPC.

Should
- model-protocol.ts:38,76-83: `session/set_mode` is entered in `pending` only so a success overlays `snapshot(state)` (frozen `modes` from session/new|load at line 72). Native `current_mode_update` still passes through unchanged (lines 51-55), but a non-empty set_mode `result.modes` would be replaced by the open-time object. The model bridge does not need this rewrite; drop `session/set_mode` from `pending` or merge `result.modes` into `state.modes` before overlay.
- model-protocol.ts:80: confirmed current is the outbound mapped `request.model` on empty success. That matches the stated native empty-success contract and later `current_model_update` (53-54) can correct it. Concurrent in-flight model sets can still apply confirmations out of order because each success writes `currentModelId` independently.

Nits
- model-protocol.ts:73: `sessions` is never evicted on close; fine for one-session transports, unbounded if many new/load cycle on one stream.
- model-protocol.ts:51-52: `config_option_update` treats `update.configOptions` as the full native list (then appends the synthetic option). A partial native list would drop sibling options until the next full snapshot.
- catalog.ts:101-105, transport.ts:47: sharing `observe` via `capture` is the right best-effort hook; open replies still go through `received` only (catalog.ts:110-115), so session/new|load is not double-captured by the protocol (model-protocol.ts:64-74 has no `capture?.`).

Correlation / confirmation / configOptions / startup (findings, not blockers)
- sent() (model-protocol.ts:25-43): only `session/set_config_option` whose `configId` equals the per-session synthetic id is rewritten to `session/set_model` with `{ sessionId, modelId }`. Bare values map only when they are not an exact catalog id, contain no `:`, the confirmed current is an exact catalog id, and that current ends with `:${bare}` (33-36). GPT-style qualified ids and `claude-subscription-directsdk-experimental:claude-opus-5-5[1m]` are forwarded as-is.
- received() (45-83): pending is keyed by caller id and deleted before applying state; missing `result` (errors) returns the native payload and does not mutate `state.models`. Synthetic select is appended as `[...nativeOptions, model]` (17-22, 67-74), and injection is skipped when native already has `category === "model"`.
- transport.ts:47,72-74,82-84: observer `sent` sees the original SDK method (new/load still match catalog.ts:108); native write sees the rewritten method; inbound is adapted before catalog `received`. `hermesCcModelProtocol(...)` runs only inside `hermesCcTransport`, not at import, and does not emit extra session/new or prompts.
- catalog.ts:98-105: `capture` is the same try/catch observer used for open results and confirmed snapshots; failures cannot fail open/prompt. Snapshots are models/modes/configOptions only (no prompt, cwd, env, images, history).
- Adjacent provider.ts:142-148 (read, not in scope): catalog observer is userOpen-only; discovery still gets a no-op protocol wrapper with `capture` undefined.

Uncertainties (honest, not used as approval)
- Exact SDK zod strictness for `session/set_mode` / `session/set_config_option` result shapes was not opened in this card. Extra snapshot fields are assumed ignored or stripped; that is why the set_mode overlay is Should, not Must.
- Companion card owns tests/fixtures; this verdict does not re-score those files.
