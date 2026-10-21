# Offline screenshot showcase

All conversation content is handwritten in `fixtures.ts`. The fictional demo
adds a free-shipping message to a shopping cart. No live host, session export,
user account, or local project is read. `sample-image.svg` is an authored checkout
illustration; Chrome rasterizes it in memory for image cards and attachments.
Paths such as `/workspace/demo-shop` and `src/cart.ts` belong to this fiction.
Web addresses use the reserved `example.com` domain and are never fetched.

The right side of the comparison and every feature card mount the actual plugin
components with the SDK hooks in `shims/`. The left side is an **illustrative
host baseline**, drawn by this offline harness, rather than a capture of an
installed Paseo host. Both sides use the same prompt, code, tool sequence, and
reply. The comparison itself labels this distinction.

## Generate

Install the main project's dependencies first, then the isolated harness tools:

```sh
npm install
npm ci --prefix .showcase
export TMPDIR="$KANBAN_TMP"
npm run typecheck --prefix .showcase
npm run capture --prefix .showcase
```

`KANBAN_TMP` must already name the task's authorized temporary directory. Google
Chrome and the macOS `sips` command must be installed. ImageMagick's `magick` is
used only if a PNG needs palette compression to meet the 500,000-byte ceiling.
Playwright uses the installed **Google Chrome**, never a downloaded browser.

The script bundles in memory, starts a loopback HTTP server, blocks external
requests, waits for fonts and images, and captures each `#shot-*` element in
light and dark themes at 1.5x resolution. Chrome's profile and raw captures stay
under `KANBAN_TMP/capture` and are removed when the process exits. A local
`capture-report.json` in `KANBAN_TMP` records the rendered text, fixture name,
and compressed byte count for each output. It is not committed.

Outputs are `images/<group>-light.png` and `images/<group>-dark.png`. The dark
captures also overwrite the existing 17 `docs/images/<group>.png` references,
including settings, so the feature table keeps its existing paths. Comparison
images are `images/compare-light.png` and `images/compare-dark.png`.

## Fixture map

Each row describes both theme captures. All data names refer to `fixtures.ts`
unless a different file is named.

| Group | Synthetic source |
| --- | --- |
| `compare` | `PROMPT`, `CALLS.search/read/edit/bash`, `CODE`, `REPLY`; `Baseline` in `showcase.tsx` uses the same values |
| `thread` | The demo conversation, `REASONING`, `TASKS`, `JOB_NOTICE`, `WRAP_UP` |
| `tool-collapsed` | `CALLS.search/read/edit/bash`, all collapsed |
| `tool-expanded` | `CALLS.bash`, expanded |
| `tool-bash` | `CALLS.bash/git` |
| `tool-read` | `CALLS.read`, `CODE` |
| `tool-image` | `CALLS.image`, `sample-image.svg` |
| `tool-edit` | `CALLS.edit`, `DIFF` |
| `tool-thinking` | `CALLS.thinking` |
| `tool-mcp` | `CALLS.mcp` |
| `tool-eval` | `CALLS.eval` |
| `tool-ask` | `CALLS.ask` |
| `tool-task` | `CALLS.task` |
| `tool-sub-agent` | `CALLS.subagent` |
| `tool-search` | `CALLS.search` |
| `tool-fetch` | `CALLS.fetch` |
| `tool-web-search` | `CALLS.websearch` |
| `tool-discovery` | `CALLS.discovery` |
| `tool-plan` | `CALLS.plan`, `TASKS` |
| `tool-todo` | `CALLS.todo` |
| `tool-failure` | `CALLS.failure`, expanded and collapsed |
| `wrap-up` | `CALLS.bash`, `WRAP_UP` |
| `generated-images` | Authored reply in `showcase.tsx`, `sample-image.svg` |
| `hub` | Authored `demo-preview` process record in `showcase.tsx` |
| `paseo` | Authored `Demo cart reviewer` record in `showcase.tsx` |
| `tool-github` | `CALLS.github` |
| `notice` | Authored demo completion and offline warnings in `showcase.tsx` |
| `reasoning` | `REASONING` |
| `tasks` | `TASKS` |
| `approval` | `APPROVAL` |
| `user` | `PROMPT`, `sample-image.svg` |
| `syntax` | `CODE`, `DIFF` |
| `settings` | Real `ClearChatSettingsPage`, default preferences, fictional host label |
