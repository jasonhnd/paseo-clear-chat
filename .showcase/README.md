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

The script reads the published image pairs from the root README and captures
only those groups. Feature images are `docs/images/<group>-light.png` and
`docs/images/<group>-dark.png`. Comparison images are `images/compare-light.png`
and `images/compare-dark.png`.

To verify the full output without replacing published images, redirect both
image directories into the task's temporary directory:

```sh
SHOWCASE_OUTPUT_ROOT="$KANBAN_TMP/showcase-output" npm run capture --prefix .showcase
```

Remove the trial images and `capture-report.json` after verification.

## Reply link replay

With the same dependencies and authorized `KANBAN_TMP`, run:

```sh
npm run test:reply-links --prefix .showcase
```

This mounts the real Markdown and reply footer with sanitized link captures and
a synthetic mail reply. Headless Google Chrome checks link line boxes and opens
every link once at 1440, 1024, 820 and 390px in both themes and all three variants.
The narrower viewports use touch input. Openers are recorded and external image
requests are intercepted locally. No live host is contacted or changed.
The JSON report is saved under `KANBAN_TMP`; the Chrome profile is removed.
See [Opening reply links](../docs/DEVELOPMENT.md#opening-reply-links) for platform
dispatch details and the pending physical-device steps.

## Code font replay

After installing the main and showcase dependencies, run from the repository root:

```sh
TMPDIR="$KANBAN_TMP" node .showcase/verify-code-font.cjs
```

This builds the actual settings, Markdown, terminal and diff components, then uses
headless Google Chrome on a free debugging port between 9444 and 9499. It checks
all six font choices at 1440, 1024, 820 and 390 pixels in both themes: computed
font families, equal character advances, option visibility and page overflow.
The terminal uses an existing sanitized fixture; reply and diff text are synthetic.
Reports, screenshots, the bundle and the temporary Chrome profile stay under
`KANBAN_TMP/code-font-browser`. The profile is removed on exit; remove the other
outputs after reading the report. Native fallback coverage runs in
`node --test test/code-font.test.cjs`; physical iOS/iPadOS/Android checks remain manual.

## Hover preview replay

After installing the root and showcase dependencies, run:

```sh
export TMPDIR="$KANBAN_TMP"
node .showcase/hover-preview.cjs
```

This bundles the actual tool components in memory and replays the sanitized
`real-hermes-session.json` fixture in headless Google Chrome. It checks mouse
hover at 1440, 1024, 820 and 390px, first-line output, pointer-lane clearance at
the top edge, scroll cleanup, context menus, clicking, data replacement and unmounting. Touch
replays use iOS, iPadOS and Android device profiles; they require no preview and
preserve tap behavior. Component tests separately exercise native platforms,
the exact 300ms delay, pen input and cancellation before the delay elapses.
Real-device checks remain separate from Chrome emulation.

Chrome uses the first available debugging port in 9444–9499. Its profile stays
under `KANBAN_TMP` and is deleted when the replay exits. No live host is read
or changed, and external network requests are blocked.

## Fixture map

Each row describes both theme captures. All data names refer to `fixtures.ts`
unless a different file is named.

| Light image | Dark image | Synthetic source |
| --- | --- | --- |
| [`images/compare-light.png`](../images/compare-light.png) | [`images/compare-dark.png`](../images/compare-dark.png) | `PROMPT`, `CALLS.search/read/edit/bash`, `CODE`, `REPLY`; `Baseline` in `showcase.tsx` uses the same values |
| [`docs/images/tool-bash-light.png`](../docs/images/tool-bash-light.png) | [`docs/images/tool-bash-dark.png`](../docs/images/tool-bash-dark.png) | `CALLS.bash/git` |
| [`docs/images/tool-read-light.png`](../docs/images/tool-read-light.png) | [`docs/images/tool-read-dark.png`](../docs/images/tool-read-dark.png) | `CALLS.read`, `CODE` |
| [`docs/images/tool-image-light.png`](../docs/images/tool-image-light.png) | [`docs/images/tool-image-dark.png`](../docs/images/tool-image-dark.png) | `CALLS.image`, `sample-image.svg` |
| [`docs/images/tool-edit-light.png`](../docs/images/tool-edit-light.png) | [`docs/images/tool-edit-dark.png`](../docs/images/tool-edit-dark.png) | `CALLS.edit`, `DIFF` |
| [`docs/images/tool-thinking-light.png`](../docs/images/tool-thinking-light.png) | [`docs/images/tool-thinking-dark.png`](../docs/images/tool-thinking-dark.png) | `CALLS.thinking` |
| [`docs/images/tool-mcp-light.png`](../docs/images/tool-mcp-light.png) | [`docs/images/tool-mcp-dark.png`](../docs/images/tool-mcp-dark.png) | `CALLS.mcp` |
| [`docs/images/tool-eval-light.png`](../docs/images/tool-eval-light.png) | [`docs/images/tool-eval-dark.png`](../docs/images/tool-eval-dark.png) | `CALLS.eval` |
| [`docs/images/tool-ask-light.png`](../docs/images/tool-ask-light.png) | [`docs/images/tool-ask-dark.png`](../docs/images/tool-ask-dark.png) | `CALLS.ask` |
| [`docs/images/tool-task-light.png`](../docs/images/tool-task-light.png) | [`docs/images/tool-task-dark.png`](../docs/images/tool-task-dark.png) | `CALLS.task` |
| [`docs/images/hub-light.png`](../docs/images/hub-light.png) | [`docs/images/hub-dark.png`](../docs/images/hub-dark.png) | Authored `demo-preview` process record in `showcase.tsx` |
| [`docs/images/paseo-light.png`](../docs/images/paseo-light.png) | [`docs/images/paseo-dark.png`](../docs/images/paseo-dark.png) | Authored `Demo cart reviewer` record in `showcase.tsx` |
| [`docs/images/reasoning-light.png`](../docs/images/reasoning-light.png) | [`docs/images/reasoning-dark.png`](../docs/images/reasoning-dark.png) | `REASONING` |
| [`docs/images/tasks-light.png`](../docs/images/tasks-light.png) | [`docs/images/tasks-dark.png`](../docs/images/tasks-dark.png) | `TASKS` |
| [`docs/images/approval-light.png`](../docs/images/approval-light.png) | [`docs/images/approval-dark.png`](../docs/images/approval-dark.png) | `APPROVAL` |
| [`docs/images/user-light.png`](../docs/images/user-light.png) | [`docs/images/user-dark.png`](../docs/images/user-dark.png) | `PROMPT`, `sample-image.svg` |
| [`docs/images/syntax-light.png`](../docs/images/syntax-light.png) | [`docs/images/syntax-dark.png`](../docs/images/syntax-dark.png) | `CODE`, `DIFF` |
| [`docs/images/settings-light.png`](../docs/images/settings-light.png) | [`docs/images/settings-dark.png`](../docs/images/settings-dark.png) | Real `ClearChatSettingsPage`, default preferences, fictional host label |
