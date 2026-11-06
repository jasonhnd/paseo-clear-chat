# Changelog

All notable changes to Clear Chat are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and each version is the Paseo version it is built and tested for plus one number that counts Clear Chat's releases for that Paseo version, for example 0.12.0.1 for the first release for Paseo 0.12.0. Releases 1.0.0 and 1.0.1 came out before this rule.

## [0.15.2.2] - YYYY-MM-DD

### Added

- A new setting, "Hide these tools": a comma-separated list of tool names, empty by default. Clear Chat removes the rows of the tools you list, so a noisy tool, for example a hook that runs on every turn, no longer fills the chat. Names are matched exactly, including upper and lower case, and spaces and empty entries are ignored. A call that failed, an approval row and a call that is waiting for approval are always drawn. When a name is in both this list and "Leave these tools to other plugins", hiding wins. A running call may be hidden; if it later fails, its row appears ([issue #216](https://github.com/jasonhnd/paseo-clear-chat/issues/216), [PR #217](https://github.com/jasonhnd/paseo-clear-chat/pull/217)).
- A new setting, "Leave these code blocks to other plugins": a comma-separated list of code block languages, not case sensitive, empty by default; `ui` and `app` are always included. A reply is left to other plugins when it has a top-level code block (a fence nested inside another code block does not count) whose first word is listed. The special name `math` also leaves replies that contain formulas: `$$ … $$`, `\( … \)`, `\[ … \]` and inline `$ … $` (no space after the opening or before the closing `$`, and the closing `$` is not followed by a digit); code blocks and inline code never count. Reproduced with three plugins that draw diagrams or formulas: with Assistant markdown on, a diagram block showed as a code block and a formula as raw text, while the same reply was drawn by the plugin when Clear Chat was disabled or Assistant markdown was off ([issue #218](https://github.com/jasonhnd/paseo-clear-chat/issues/218), [PR #222](https://github.com/jasonhnd/paseo-clear-chat/pull/222)).
- A new setting, "Fold messages that start with": one message beginning per line, case sensitive, white space at the start of the message ignored, empty by default. A matching user message is drawn as one line (its first line cut at about 120 characters, the time, and a Show button) each time the chat is opened; Show opens the whole message and Hide folds it again, and both buttons have accessible labels and are at least 44 points high. A message that Clear Chat can tell carries an image or another attachment is not folded. The find bar still finds the text of a folded message. The setting needs "Enhanced prompt bubble" to be on ([issue #219](https://github.com/jasonhnd/paseo-clear-chat/issues/219), [PR #224](https://github.com/jasonhnd/paseo-clear-chat/pull/224)).
- A new setting, "Show an Open button on code blocks that hold only a web address", off by default. When it is on, a closed code block whose whole content is exactly one `https://` address gets an Open button beside Copy. There is no button for `http://` addresses, for `localhost`, `127.0.0.1`, `[::1]` and `.local` hosts, for other schemes, for two addresses, for an address with other text, or for a code block that is still being written. Copy is unchanged, and the button is at least 44 points high ([issue #220](https://github.com/jasonhnd/paseo-clear-chat/issues/220), [PR #223](https://github.com/jasonhnd/paseo-clear-chat/pull/223)).

### Fixed

- "Fold messages that start with" now folds a matching message for every provider. At first it folded a message only when the pasted-image lookup could answer, which the lookup does for only some providers, so for the others nothing was folded. A message is now folded unless the lookup finds images; while the lookup is pending the message is drawn folded, and if images then arrive the row opens and stays open ([issue #226](https://github.com/jasonhnd/paseo-clear-chat/issues/226), [PR #228](https://github.com/jasonhnd/paseo-clear-chat/pull/228)).

### Compatibility

- Clear Chat 0.15.2.2 is the Clear Chat release for Paseo 0.15.2.
- The release candidate was checked on an isolated host running Paseo 0.15.2: it installs and loads; the settings page version line reads 0.15.2.2 in English, Chinese and Japanese; the full regression suite (1,961 tests) and the type check pass; the page layout passes in 24 cases (six widths, three folding modes) and in 6 sub-agent cases; the folding row and the Open button were also checked at 390 px wide; a message with an attached image is not folded on a Hermes·CC provider; the earlier product spot checks (command steps, the reasoning card, the quote panel, file paths in inline code, the time format) still pass. With real diagram and formula plugins installed, each on its own (mermaid, pele and a math renderer), listing their names in "Leave these code blocks to other plugins" makes them draw their diagrams and formulas; with the list empty, in plain replies, for a block nested inside another code block and for text such as "costs $5 and $10", nothing changes. "Hide these tools", "Fold messages that start with" (on a base provider and on a Hermes·CC provider, including the find bar) and the Open button were checked at desktop width. Items not listed here have not been checked on Paseo 0.15.2, among them the new settings at phone width other than the folding row and the Open button (both checked at 390 px), and real models and real devices.

### Known limitations

- A matching message that carries pasted images may show folded for a moment before the image lookup answers, and then opens.
- For a provider that gives Clear Chat no information about a message's images and whose image lookup cannot answer, a matching message with an attached image is folded too; Show opens it.
- When no plugin draws a code block that Clear Chat leaves to other plugins, Paseo draws the reply itself and Clear Chat's styling does not apply to it.
- The limitations listed in the previous release still apply.

### Upgrading

- Update an existing installation with `paseo plugin update clear-chat --ref v0.15.2.2`; the plugin reloads on its own and the Paseo daemon is not restarted. The four new settings are empty or off until you change them. Removing a plugin also removes its settings, so back them up before removing.

## [0.15.2.1] - 2026-11-06

### Added

- A new setting, "Leave these tools to other plugins": a comma-separated list of tool names, empty by default. Clear Chat does not draw the rows of the tools you list, so another plugin that draws tool rows can. Names are matched exactly, including upper and lower case, and spaces around a name are ignored. The value is saved with the other settings, and the reset clears it ([issue #207](https://github.com/jasonhnd/paseo-clear-chat/issues/207), [PR #209](https://github.com/jasonhnd/paseo-clear-chat/pull/209)).

### Changed

- A reply that contains a `ui` or `app` code block is left to the plugin that draws such blocks, so it is no longer shown as code. A reply counts when a code fence starts with the word `ui` or `app` (any case, up to three spaces of indentation, backticks or tildes, an unclosed fence counts so a reply that is still streaming already yields); a fence quoted inside another code block does not count. When no plugin draws the block, Paseo draws the reply itself and Clear Chat's styling does not apply to it ([issue #206](https://github.com/jasonhnd/paseo-clear-chat/issues/206), [PR #208](https://github.com/jasonhnd/paseo-clear-chat/pull/208)).
- The README's "what a plugin cannot do" table names, in every row, the issue, pull request or discussion in Paseo's official repository where you can follow the item, and has a new row for opening a file from a path you press on a remote client ([issue #204](https://github.com/jasonhnd/paseo-clear-chat/issues/204), [PR #205](https://github.com/jasonhnd/paseo-clear-chat/pull/205)).
- The README opens with the demo GIF only, and the Paseo badge shows the Paseo version Clear Chat was tested on ([issue #199](https://github.com/jasonhnd/paseo-clear-chat/issues/199), [PR #201](https://github.com/jasonhnd/paseo-clear-chat/pull/201), [PR #202](https://github.com/jasonhnd/paseo-clear-chat/pull/202)).

### Fixed

- Opening a provider sub-agent's read-only pane no longer makes Clear Chat ask the host for the timeline of the pane's synthetic id, which logged "Agent not found" on the host each time ([issue #210](https://github.com/jasonhnd/paseo-clear-chat/issues/210), [PR #212](https://github.com/jasonhnd/paseo-clear-chat/pull/212)).

### Compatibility

- Clear Chat 0.15.2.1 is the Clear Chat release for Paseo 0.15.2. In Paseo 0.15.2, `@getpaseo/plugin` is byte-for-byte the same as in Paseo 0.15.1, and `@getpaseo/client` only gains one method that Clear Chat does not use.
- The previous Clear Chat release was checked on a Paseo 0.15.2 host: the product items passed; the full regression suite passed (1,894 tests) and so did the type check; the page layout passed in 18 cases (six widths, each with the three folding modes). A later development state passed 1,909 tests and the same 18 layout cases. A sub-agent read-only pane was read with a test provider: Clear Chat draws its own rows there, and Paseo's whole-turn folding does not fold them. On phone and iPad widths, Paseo 0.15.2's own toolbar buttons are 28 px tall; that is the host's behaviour and is not counted as a Clear Chat defect.
- The release candidate was checked on an isolated host running Paseo 0.15.2: it installs and loads; the plugin API comparison with Paseo 0.15.1 shows only an added method; the settings page version line reads 0.15.2.1 in English, Chinese and Japanese; the product spot checks (command steps, the reasoning card, the quote panel, file paths in inline code, the time format) pass; the full regression suite (1,914 tests) and the type check pass; the page layout passes in 18 cases (six widths, three folding modes). With a test generative-UI plugin installed, a reply with a `ui` code block is drawn by that plugin; with a test tool-row plugin, listing a tool in the new setting hands that tool's rows to it, after a reload of the chat. In a sub-agent read-only pane opened with a test provider, the host no longer logs "Agent not found". Items not listed here have not been checked on Paseo 0.15.2.

### Known limitations

- Without a plugin that draws `ui` or `app` code blocks, a reply that contains one is drawn by Paseo, and Clear Chat's styling does not apply to it.
- Paseo's whole-turn folding does not fold what Clear Chat draws; see the row about turn folding in the README's "what a plugin cannot do" table.
- The limitations listed in the previous release still apply.

### Upgrading

- Update an existing installation with `paseo plugin update clear-chat --ref v0.15.2.1`; the plugin reloads on its own and the Paseo daemon is not restarted. Removing a plugin also removes its settings, so back them up before removing.

## [0.15.1.1] - 2026-11-05

### Added

- A file path written in inline code in a reply now opens the file, the same way a path in running text does. Only a single path counts (a bare word, text with spaces or a web address stays plain text), and the file must exist inside the agent's workspace; a path to a missing file, or outside the workspace, or through a symbolic link that leaves the workspace, opens nothing and shows the existing "could not be opened" message. Copying a reply still copies the original Markdown unchanged, and paths in tool cards, code blocks and explicit Markdown links keep their current behaviour ([issue #163](https://github.com/jasonhnd/paseo-clear-chat/issues/163), [PR #165](https://github.com/jasonhnd/paseo-clear-chat/pull/165)).

### Changed

- A path with spaces written in inline code in a reply is no longer a link (it used to be); write it as a Markdown link instead. A single path without spaces is a link ([issue #163](https://github.com/jasonhnd/paseo-clear-chat/issues/163), [PR #165](https://github.com/jasonhnd/paseo-clear-chat/pull/165)).
- The settings page version line has a clear hierarchy: the installed version stands out from its label, the note under it is narrower so the Chinese text no longer ends on a very short last line, and the accent colour card no longer has a black border on top ([issue #147](https://github.com/jasonhnd/paseo-clear-chat/issues/147), [PR #164](https://github.com/jasonhnd/paseo-clear-chat/pull/164)).
- The quote panel shows the quoted message as Markdown, with a vertical bar on its left that marks it as a quotation. The text that is sent does not change: it is still the raw quoted text prefixed with `> ` ([issue #166](https://github.com/jasonhnd/paseo-clear-chat/issues/166), [PR #169](https://github.com/jasonhnd/paseo-clear-chat/pull/169)).
- The quote panel uses the conversation font, so bold text is visible on machines whose system font has no bold face, and it follows the Clear Chat font setting ([issue #172](https://github.com/jasonhnd/paseo-clear-chat/issues/172), [PR #175](https://github.com/jasonhnd/paseo-clear-chat/pull/175)).
- The time in a prompt's header uses the same format as the reply footer: it follows the locale, has no seconds, and shows the weekday or date for older messages. Before, the prompt header always printed a 24-hour time with seconds, so the two disagreed within one conversation ([issue #170](https://github.com/jasonhnd/paseo-clear-chat/issues/170), [PR #178](https://github.com/jasonhnd/paseo-clear-chat/pull/178)).
- In a Hermes·CC conversation, a command step is now shown as a shell step, the same as with the base Hermes provider: the command sits in a terminal frame, and the step details show the command, its output and its exit code. When the command fails, the Error line reads "Command exited with code N". The bold asterisks around the labels of Hermes' result in the output are gone, as with the base provider. The wrapper itself (the "terminal result" and "exit_code" lines) is still part of the Output, and Copy gives the original text ([issue #184](https://github.com/jasonhnd/paseo-clear-chat/issues/184), [issue #187](https://github.com/jasonhnd/paseo-clear-chat/issues/187); [PR #185](https://github.com/jasonhnd/paseo-clear-chat/pull/185), [PR #188](https://github.com/jasonhnd/paseo-clear-chat/pull/188)).

### Fixed

- A reasoning card with one step or one token reads "1 step" and "1 token" in English instead of "1 steps". The Chinese and Japanese text is unchanged ([issue #167](https://github.com/jasonhnd/paseo-clear-chat/issues/167), [PR #182](https://github.com/jasonhnd/paseo-clear-chat/pull/182)).
- A failed shell step with a non-zero exit code now reads "Command exited with code N" on its Error line and in Copy error (in English, Chinese and Japanese) instead of "Tool call failed", when the provider gave no error text. Steps with a zero or missing exit code, other tools, and steps that carry a real error text keep their current message ([issue #168](https://github.com/jasonhnd/paseo-clear-chat/issues/168), [issue #180](https://github.com/jasonhnd/paseo-clear-chat/issues/180); [PR #173](https://github.com/jasonhnd/paseo-clear-chat/pull/173), [PR #181](https://github.com/jasonhnd/paseo-clear-chat/pull/181), [PR #185](https://github.com/jasonhnd/paseo-clear-chat/pull/185)).

### Internal

- The pre-release check now fails when the version in `package.json`, the lockfile or the manifest differs from the changelog heading ([issue #161](https://github.com/jasonhnd/paseo-clear-chat/issues/161), [PR #162](https://github.com/jasonhnd/paseo-clear-chat/pull/162)), and when the release date in the changelog heading or the release notes is not the tag day in Japan Standard Time; `--tag-day YYYY-MM-DD` sets the tag day explicitly ([issue #176](https://github.com/jasonhnd/paseo-clear-chat/issues/176), [PR #179](https://github.com/jasonhnd/paseo-clear-chat/pull/179)).

### Compatibility

- Clear Chat 0.15.1.1 is the Clear Chat release for Paseo 0.15.1. Paseo 0.15.1 fixes one problem: on Windows machines where PowerShell 5.1 cannot run `Get-CimInstance`, the daemon did not start when the terminal worker could not read its own process identity. It does not change the plugin interface: `@getpaseo/plugin` and `@getpaseo/client` are byte-for-byte the same as in Paseo 0.15.0, so no export is added or removed, and Clear Chat's behaviour does not change because of it. Clear Chat was installed on a Paseo 0.15.1 host and the following were spot-checked there: the settings page version line, failed and successful command steps, a one-step reasoning card, the quote panel, file paths in inline code and the time format; the full regression suite and the type check pass. The other host-side acceptance items are recorded as not checked, not as passed.

### Upgrading

- Update an existing installation with `paseo plugin update clear-chat --ref v0.15.1.1`; the plugin reloads on its own and the Paseo daemon is not restarted. Removing a plugin also removes its settings, so back them up before removing.
- With a directory install, the version shown on the settings page is the version metadata already in that directory, so it can show an older release than the one you installed.

### Known limitations

- Selecting text on a real iPhone, and an entry point for Rewind, have not been verified and are not part of this release.
- The limitations listed in the first release for Paseo 0.15.0 still apply.

## [0.15.0.2] - 2026-11-04

### Changed

- The quote action under a message is now an icon button beside the copy button, drawn at the same size and colour, instead of a text label. It keeps its accessible name and its hover title in English, Chinese and Japanese; pressing it still opens the quote panel, and it is still greyed out while the agent is busy ([issue #151](https://github.com/jasonhnd/paseo-clear-chat/issues/151), [PR #152](https://github.com/jasonhnd/paseo-clear-chat/pull/152)).

## [0.15.0.1] - 2026-11-03

### Added

- You can quote a message and reply to it: pick the quote action on a message, write your reply in Clear Chat's own composer, and it is sent as the quoted block, a blank line and your reply ([issue #128](https://github.com/jasonhnd/paseo-clear-chat/issues/128), [PR #130](https://github.com/jasonhnd/paseo-clear-chat/pull/130)).
- The settings page shows the version of the installed Clear Chat build, with a line explaining that a directory install keeps the version information already in that directory, so it can show an older release ([issue #84](https://github.com/jasonhnd/paseo-clear-chat/issues/84), [PR #123](https://github.com/jasonhnd/paseo-clear-chat/pull/123)).

### Fixed

- When two writers touched the same conversation at the same moment, Clear Chat could report that conversation as unsafe instead of waiting for the other writer. It now retries for up to 15 seconds; a lock that is genuinely unsafe is still reported ([issue #138](https://github.com/jasonhnd/paseo-clear-chat/issues/138), [PR #139](https://github.com/jasonhnd/paseo-clear-chat/pull/139)).
- The reply elapsed-time label is no longer shown when the displayed whole-second value would be zero, or when the duration is missing or invalid; durations of one second or more keep their existing formatting, and tool-step timing is unchanged ([issue #82](https://github.com/jasonhnd/paseo-clear-chat/issues/82), [PR #140](https://github.com/jasonhnd/paseo-clear-chat/pull/140)).

### Internal

- A release check script keeps the package, lockfile and manifest versions in step, scans for stale version strings outside the changelog history, runs the tests and the type checker, and prints a SHA-256 sheet of the files going into a release ([issue #127](https://github.com/jasonhnd/paseo-clear-chat/issues/127), [PR #129](https://github.com/jasonhnd/paseo-clear-chat/pull/129)). The stale version scan reads the previous two releases off the changelog, stops before the changelog history and its compare links, and still accepts the documented Paseo 0.13 references ([issue #143](https://github.com/jasonhnd/paseo-clear-chat/issues/143), [PR #144](https://github.com/jasonhnd/paseo-clear-chat/pull/144)).
- No-model fixtures now cover the background-task lifecycle, a timeline reset and a gap in sequence numbers, late-idle delivery, multi-source concurrency, and idle protection with a refusal ([issues #91 to #95](https://github.com/jasonhnd/paseo-clear-chat/issues/91), [PR #124](https://github.com/jasonhnd/paseo-clear-chat/pull/124), [PR #125](https://github.com/jasonhnd/paseo-clear-chat/pull/125), [PR #126](https://github.com/jasonhnd/paseo-clear-chat/pull/126), [PR #133](https://github.com/jasonhnd/paseo-clear-chat/pull/133), [PR #134](https://github.com/jasonhnd/paseo-clear-chat/pull/134)).
- The stale-version regression derives its expected prefix from the manifest instead of a literal release string, so it keeps working across releases ([issue #103](https://github.com/jasonhnd/paseo-clear-chat/issues/103), [PR #117](https://github.com/jasonhnd/paseo-clear-chat/pull/117)).
- An investigation records how a synthetic Codex history replay without timestamps changes a rendered "Worked for 21s" reply to "Worked for 0s", together with a reproduction test. The display defect itself is fixed in the entry under Fixed ([issue #82](https://github.com/jasonhnd/paseo-clear-chat/issues/82), [PR #132](https://github.com/jasonhnd/paseo-clear-chat/pull/132)).
- The Paseo server package those fixtures need is a development-only dependency; it is not shipped with the plugin.

### Compatibility

- Compatibility with Paseo 0.15.0 was checked at the source level: 0.15.0 removes no export from `@getpaseo/plugin` or `@getpaseo/client` (it adds nine and seven), every one of the 39 exports Clear Chat imports is present with unchanged declarations, and Clear Chat does not use the lifecycle hooks that were renamed in 0.15.0. Host-side acceptance results are recorded separately (see the next point).
- On Paseo 0.15.0 the plugin installs, builds and loads, and its source-level API surface is unchanged; the remaining host-side acceptance items are listed as not verified in the acceptance record, not as passed.

### Known limitations

- **Sending a quoted reply while the assistant is answering.** When you send a quoted reply, Clear Chat first checks whether the assistant is idle. If it is busy, the message is not sent: your draft is kept and Clear Chat asks you to send it later. In a rare case — the assistant starts answering after that check but before your message arrives — the message can still interrupt that answer. A way to insert a message without interrupting was tested; in that test the original answer was cut off, so Clear Chat does not use it.
- The **·CC** provider list is rebuilt from the current provider configuration when Clear Chat starts or reloads, not while it is running; after changing providers, run `paseo plugin reload clear-chat` to update it ([issue #141](https://github.com/jasonhnd/paseo-clear-chat/issues/141)).
- With a directory install, the version shown on the settings page is the version metadata already in that directory, so it can show an older release than the one you installed ([issue #84](https://github.com/jasonhnd/paseo-clear-chat/issues/84), [PR #123](https://github.com/jasonhnd/paseo-clear-chat/pull/123)).

## [0.14.0.4] - 2026-11-01

### Fixed

- The version shown on Paseo’s plugins page and the package version now match the release they belong to, so an installed build can be identified at a glance ([issue #121](https://github.com/jasonhnd/paseo-clear-chat/issues/121)).

## [0.14.0.3] - 2026-10-31

### Fixed

- Clear Chat now notices when two writers that both carry the new identity information record the same conversation. Instead of mixing their records, that conversation is shown with Hermes’s own text ([issue #110](https://github.com/jasonhnd/paseo-clear-chat/issues/110), [PR #114](https://github.com/jasonhnd/paseo-clear-chat/pull/114)). Records written by earlier versions carry no such identity and replay as ordinary history.
- When a message cannot be written to the saved copy, the window no longer ends. Clear Chat reports that message as not sent, and sending it again works once the storage is available.

### Changed

- Repository text no longer uses a personal name: the contributor guidelines and the licence attribution now use the project’s public account handle ([issue #112](https://github.com/jasonhnd/paseo-clear-chat/issues/112), [PR #118](https://github.com/jasonhnd/paseo-clear-chat/pull/118)).

### Known limitations

- **A storage location Clear Chat cannot write to.** Your conversation is not damaged and nothing has been deleted. When Clear Chat cannot read or update its saved copy of a conversation, it shows that conversation with Hermes's own text instead; a location that is read-only and cannot be written to gives the same result. This is a fallback, not a sign that the record was damaged or that data was lost.
- **What “saved” means.** Clear Chat counts a message as saved only after the storage confirms that the whole message was written. When that confirmation does not arrive, the window stays open and Clear Chat reports the message as not sent, so you can send it again. The exact wording shown at that moment has not been verified on a real host yet. Clear Chat does not promise that content is never lost.
- The read-only case was measured on macOS and on a full volume. The equivalent on Linux has not been tested.

### Upgrading

- Update an existing installation with `paseo plugin update clear-chat --ref v0.14.0.3`; review the README before changing versions. Removing a plugin also removes its settings.

## [0.14.0.2] - 2026-10-31

Needs Paseo 0.14.0 or later.

### Added

- The Clear Chat description shows the installed version on Paseo’s plugins page, so you can identify it at a glance ([issue #99](https://github.com/jasonhnd/paseo-clear-chat/issues/99), [PR #100](https://github.com/jasonhnd/paseo-clear-chat/pull/100)).
- Added a pull request template for linking the issue and documenting scope, risks, rollback and verification ([issue #101](https://github.com/jasonhnd/paseo-clear-chat/issues/101), [PR #102](https://github.com/jasonhnd/paseo-clear-chat/pull/102)).

### Changed

- Improved the existing bug and feature report forms; UI reports request redacted visual evidence, and Chinese and Japanese reports remain welcome ([issue #101](https://github.com/jasonhnd/paseo-clear-chat/issues/101), [PR #102](https://github.com/jasonhnd/paseo-clear-chat/pull/102)). Live GitHub form rendering and submission have not been tested.

### Known limitations

- Paseo 0.14.0 displays the default English description in the plugin list even when the app language is changed; translated listing metadata does not change that display.
- Windows and the production desktop client have not been tested for this change. The isolated host check covered an existing Git installation update and one synthetic setting, not a fresh installation or all settings.
- Paseo’s whole-turn folding and text-size settings do not apply to Clear Chat-drawn content; use Clear Chat’s own text-size setting. Find searches loaded messages only; scroll up to load older ones.
- The documented Paseo 0.13 install and switch commands, their effect on settings and switching from a newer release to the older one have not been tested on Paseo 0.13.

### Upgrading

- Update an existing installation with `paseo plugin update clear-chat --ref v0.14.0.2`; review the README before changing versions. Removing a plugin also removes its settings.

## [0.14.0.1] - 2026-10-30

Needs Paseo 0.14.0 or later.

### Changed

- Clear Chat 0.14.0.1 needs Paseo 0.14.0 or later.
- Added public automated checks for dependency installation, TypeScript and the existing tests on pushes to `pre` and `main`, and on pull requests.

## [0.13.2.2] - 2026-10-29

Needs Paseo 0.13.0 or later.

### Fixed

- Prevents a compatibility issue in which certain failed tool calls with no error message could make a **·CC** conversation's history fail to open. Conversations already affected by this issue may still fail to open after upgrading; there is currently no automatic fix for those affected conversations.

## [0.13.2.1] - 2026-10-28

Built and tested on Paseo 0.13.2. Needs Paseo 0.13.0 or later.

### Fixed

- **·CC** agents can now choose a model and a permission mode, like the original Hermes agents. The permission modes appear in the list after you open a **·CC** window for the first time and Paseo refreshes its options (or after you reload); the models do too, unless your Hermes provider settings already list them.

- **·CC** entries now use the Hermes icon.
- Creating a **·CC** agent with a selected model now works when Hermes reports its models through its native interface. If Hermes rejects a model selection, Clear Chat reports the error instead of silently choosing another model.

## [0.13.1.1] - 2026-10-26

Built and tested on Paseo 0.13.1. Needs Paseo 0.13.0 or later.

### Added

- Images pasted into a prompt now also show in the prompt bubble for Hermes agents, with **Enhanced prompt bubble** on. When you create a new agent in Paseo, choose the **·CC** version of your Hermes provider, for example **Hermes·PP·CC**. Clear Chat saves the pasted images in its own folder before it passes your prompt to Hermes, unchanged, and shows an image only when it matches the exact message. After Paseo's background service restarts, your Mac restarts, you upgrade Paseo, or Paseo is killed or crashes while no reply is in progress, the images and your original prompt text are still there.
  - Only prompts sent in a **·CC** agent with this version or later show images. Agents you started before, and their old messages, do not.
  - If the saved record does not match, has been changed, or you used a slash command or a revert such as `/undo`, Clear Chat falls back to Hermes's own text for that conversation and shows no images.
  - Use one conversation from one window at a time. If a second window sends a prompt to the same conversation, both windows fall back to Hermes's own text.
  - The images take up to 2 GB in Clear Chat's own folder; when it is full, the oldest are deleted first.
- New setting **Hermes·CC providers**, on by default, controls whether the **·CC** versions are added. Changes apply after you reload the host. The **·CC** agents you already created stay in the list, but opening one shows "Failed to load agent" until you turn the setting back on and reload; the conversation is not lost, and its text and images are back when you do.

### Changed

- The README now explains pasted images in Hermes agents, and no longer lists Hermes as unsupported.

## [0.13.0.2] - 2026-10-26

### Added

- With **Enhanced prompt bubble** on, images you paste into a prompt now show in the prompt bubble, for Codex and Claude agents. Up to three thumbnails show, with a count for the rest (for Claude, the count can be too low when one message has more than 20 images); tap one to see it full size. Clear Chat finds the images read-only in the agent's own history on the host, and shows nothing rather than a wrong image when it cannot match them. The images are not sent to any other service. Images larger than 1.5 MB or 24 megapixels are not shown. Hermes agents are not supported yet; turn **Enhanced prompt bubble** off to see their pasted images in Paseo's own bubble.

### Changed

- Long conversations stay smoother, especially on slower devices such as phones. Clear Chat no longer reloads the whole conversation each time an agent starts or finishes a turn; it usually reads only what is new. In our test with a long Codex conversation, the pauses long enough to make the screen stutter dropped from six to two per turn.
- The README is rewritten, with new screenshots for phones, iPad and the settings page, and a list of what a plugin cannot do.

## [0.13.0.1] - 2026-10-25

Needs Paseo 0.13.0 or later. If you still use Paseo 0.12, install Clear Chat 0.12.0.1.

### Added

- Clear Chat's own interface text follows the Paseo app language, in English, Simplified Chinese and Japanese.

### Changed

- Clear Chat now needs Paseo 0.13.0 or later.
- The plugin's short description in Settings → Plugins now says what Clear Chat does. It replaces the description inherited from the original project.
- With **Enhanced prompt bubble** on, images pasted into a prompt no longer show in the prompt bubble, because Paseo 0.13 does not pass them to plugins. The images are still sent to the agent. Turn the setting off to see them in Paseo's own bubble.

### Fixed

- When installation fails, the message now includes the last lines of npm's own error output. Long npm output no longer causes a false "could not start" error, and an empty error stream falls back to npm's normal output.
- An image that is referenced more than once now shows every time.
- MCP tool errors are now also recognised when Paseo reports them in its structured MCP result format, so they show once in the conversation, with the full text in the details and in Copy.
- A file name on its own inside quotes, such as "README.md", is no longer turned into a path link.
- Step details no longer open twice when you narrow the window from desktop to phone width.
- Step details keep your reading position when the window is resized or rotated.

### Security

- Updated dependencies. No dependencies with critical known vulnerabilities remain.

## [0.12.0.1] - 2026-10-23

The first release numbered after the Paseo version. It needs Paseo 0.12.0 or later.

### Added

- **Step details.** Click a collapsed step to see its full input and output, the exit code of a shell command and the duration when the agent reports it, with separate copy buttons, in a bottom sheet on phones, a popover on tablets, or a side panel on desktop. A new setting, **When a collapsed step is pressed**, switches back to expanding steps inside the conversation.
- Step details follow the window width (bottom sheet below 744px, popover from 744 to 1023px, side panel from 1024px) and keep the selected step and reading position when the window is resized, an iPad is rotated or Split View is used. Very long output scrolls smoothly.
- Keyboard controls for steps in browsers and the desktop app: Up and Down move between steps, Enter opens details, Escape closes them and returns focus. Native mobile apps keep touch controls.
- Long code blocks in replies and long prompts now fold by the **Fold long output after** setting, with **Show all N lines** and a full-text **Copy**.
- Hover preview on desktop: rest the mouse on a collapsed step to see its summary and result. File reads show up to 6 lines.
- Step menu: right-click or long-press a step for Copy command, Copy path, Copy result and Open in file manager. Items appear only when they apply, and the menu flips near screen edges.
- **Custom accent colour.** Pick a swatch or enter a HEX value. The colour you see is adjusted when needed to keep text contrast at 4.5:1 or higher; the saved value stays exact.
- **Code font** setting: Default (Iosevka), Iosevka, Menlo, Consolas, Fira Code or Cascadia Code.
- **Highlight text.** `==marked text==` highlights text in replies.
- A **Troubleshooting** section in the README.

### Changed

- Clear Chat now needs Paseo 0.12.0 or later.
- Paths in replies open the file in the host's file manager. On phones, tablets and narrow web windows they are copied to the clipboard instead.
- On phone-width screens, titles, status text, icons and padding are smaller, so more steps fit on one screen. Tap targets keep their size.

### Fixed

- Replies now use Clear Chat styling as soon as a conversation opens. Before, tool rows were styled at once but replies kept Paseo's own look until the window was resized.
- Shell steps now show the exit code when Claude, Codex or Hermes reports one, and a failed step keeps its full error text for display and copying.

## [1.0.1] - 2026-10-22

### Fixed

- Tool rows no longer show image previews for image paths that only appear inside text a tool read, such as a README. Tool output now shows an image only when the tool read or wrote that image file itself, or reported that it generated one. Images written in replies work as before.

## [1.0.0] - 2026-10-22

First release under the name Clear Chat.

### Added

- Dedicated cards for all 12 tool kinds that Paseo reports: shell, read, edit, write, search, fetch, web search, subagent, plan, todo, plain text and unknown. No tool call is shown as an empty box.
- Dedicated rows for Hermes tools: `skill_view` shows **Skill: name**, and tools such as `memory`, `tool_call` and `tool_search` show their name with the key argument, for example **memory · add**.
- Finished tool calls fold into one compact row. Click to open or close a row. The choice is remembered across reloads and history. Running, failed and waiting calls open by default.
- Long code and output fold after 15 lines, with **Show all N lines**. Two new settings: **Fold finished steps** and **Fold long output after**.
- Replies sent through a `wrap_up` tool render as a full reply card, with recap, question, lettered options and a **Blocked** alert.
- Images in replies and from tools: Markdown images, generated images, local paths and image URLs, each with a clickable source. An image written in a reply that cannot load shows why, together with its address.
- Clickable links in replies on desktop, web and iOS, including bare URLs and `mailto:` links.
- Failed tool calls show their error message.
- Prompts with pasted images show the image count, such as "3 images attached", even when an image cannot be previewed.
- Past approvals stay in the conversation as short status rows.

### Changed

- Renamed from Beautiful Chat to Clear Chat. The plugin ID is now `clear-chat`.
- Settings move over from Beautiful Chat on first start. The old settings are kept unchanged.

### Fixed

- [#3](https://github.com/ABorakati/beautiful-chat/issues/3): Markdown images in replies now show as images.
- [#4](https://github.com/ABorakati/beautiful-chat/issues/4): Links in replies can now be clicked.
- [#8](https://github.com/ABorakati/beautiful-chat/issues/8): Edits now show a diff when the tool sends only the old and new text.
- [#12](https://github.com/ABorakati/beautiful-chat/issues/12): Generated images now display, and their address can be clicked.
- [#14](https://github.com/ABorakati/beautiful-chat/issues/14): Edits that report only old and new text now get a diff.
- [#17](https://github.com/ABorakati/beautiful-chat/issues/17): Pasted images no longer disappear silently from the prompt bubble.
- [#19](https://github.com/ABorakati/beautiful-chat/issues/19): Failed tool calls now show their error.

Based on Beautiful Chat by ABorakati.

[0.15.2.2]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.15.2.1...v0.15.2.2
[0.15.2.1]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.15.1.1...v0.15.2.1
[0.15.1.1]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.15.0.2...v0.15.1.1
[0.15.0.2]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.15.0.1...v0.15.0.2
[0.15.0.1]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.14.0.4...v0.15.0.1
[0.14.0.4]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.14.0.3...v0.14.0.4
[0.14.0.3]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.14.0.2...v0.14.0.3
[0.14.0.2]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.14.0.2
[0.14.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.14.0.1
[0.13.2.2]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.13.2.2
[0.13.2.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.13.2.1
[0.13.1.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.13.1.1
[0.13.0.2]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.13.0.2
[0.13.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.13.0.1
[0.12.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.12.0.1
[1.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v1.0.1
[1.0.0]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v1.0.0