## [0.15.4.1] - 2026-11-11

### Added

- Each question in the answer card adds a write-your-own option after the listed options, with the next letter. Press Enter to confirm and move on, or Shift+Enter for a new line; choosing a character with an input method does not confirm the answer. An empty answer shows a prompt ([#447](https://github.com/jasonhnd/paseo-clear-chat/issues/447)).
- Preview the message before sending. The Send button shows only the letter indexes. After sending, the grey read-only card lets you switch questions to view each answer; your full written answers remain visible after reloading ([#447](https://github.com/jasonhnd/paseo-clear-chat/issues/447)).
- Fenced code blocks and Mermaid diagrams in replies are drawn by Paseo's own Markdown component, and a code block shows its language in a bar above the code; where the host cannot draw it, the source is shown instead ([#374](https://github.com/jasonhnd/paseo-clear-chat/issues/374), [#375](https://github.com/jasonhnd/paseo-clear-chat/issues/375), [#376](https://github.com/jasonhnd/paseo-clear-chat/issues/376), [#384](https://github.com/jasonhnd/paseo-clear-chat/issues/384)).
- Copying a code block that Clear Chat draws keeps the line break at the end of the code ([#441](https://github.com/jasonhnd/paseo-clear-chat/issues/441)).

### Changed

- In the dark theme, the thin selection border and the keyboard-focus border on the write-your-own row now use the host foreground text colour; the light theme keeps the accent colour, the letter badges keep the accent colour, and there is still a single border ([#447](https://github.com/jasonhnd/paseo-clear-chat/issues/447)).
- On a touch screen, the copy buttons Clear Chat draws are 44 px high ([#388](https://github.com/jasonhnd/paseo-clear-chat/issues/388)).
- After you confirm a written answer, the focus moves to the next question's write-your-own row ([#434](https://github.com/jasonhnd/paseo-clear-chat/issues/434)).
- Opening, editing, confirming and sending the answer card now animate over about 150–220 ms, and with the system's reduced motion setting on they move and fade less ([#436](https://github.com/jasonhnd/paseo-clear-chat/issues/436), [#378](https://github.com/jasonhnd/paseo-clear-chat/issues/378)).
- At phone width the write-your-own input is 16 px, so a phone browser does not zoom when it gets the focus, and the hint line keeps its height ([#436](https://github.com/jasonhnd/paseo-clear-chat/issues/436)).

### Fixed

- When the answer card turns grey read-only after Send, the page's bottom position is no longer clipped by the browser ([#436](https://github.com/jasonhnd/paseo-clear-chat/issues/436)).
- A reply that ends with extra blank lines no longer loses its diagrams and syntax highlighting ([#444](https://github.com/jasonhnd/paseo-clear-chat/issues/444)).
- After **Send** confirms the current written answer, the keyboard focus moves to the first focusable control of the next unanswered question; confirming the last question leaves the focus on the first tab of the read-only answer card, and no focus ring is left behind when Send turns grey ([#449](https://github.com/jasonhnd/paseo-clear-chat/issues/449)).
- An ordinary option answer sent by an older release whose question numbers start at 0 now shows as answered, with the check on the matching row, after the chat is reloaded; the `Answered in the chat: …` text is unchanged and current numbering is not affected ([#448](https://github.com/jasonhnd/paseo-clear-chat/issues/448)).

### Known limitations

- In the read-only answer frame, Space on a focused question tab does not switch questions because Paseo handles the key first. Click the tab or press Enter instead.
- In the checked web cases, if you scroll up above the answer card and then confirm an answer, the page may jump straight back to the bottom; in the checked cases the confirmation was already smooth when the page was at the bottom. The cause is still being investigated ([#436](https://github.com/jasonhnd/paseo-clear-chat/issues/436)).
- In the checked cases, a final line break or two spaces followed by a line break were present in the send preview but absent from the stored message. After reloading, the read-only frame and prompt bubble matched the stored text.
- In a test on Paseo 0.15.3, a host-rendered code block ending in two line breaks was copied with neither line break by the host's **Copy** button ([#441](https://github.com/jasonhnd/paseo-clear-chat/issues/441)).
- In a phone-width simulated touch test, the **Copy** button at the top right of a code block drawn by Paseo measured about 22 × 22 px. It belongs to Paseo's own component; the public plugin types we checked in Paseo v0.15.3 offer no option to resize it. In the same test, the plugin's reply-copy button and its own copy button on a folded long code block were 44 px high ([#388](https://github.com/jasonhnd/paseo-clear-chat/issues/388)).

### Upgrade notes

- Update from an earlier release with `paseo plugin update clear-chat --ref v0.15.4.1 --yes`; a new install uses `paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.15.4.1`.
- Settings are kept as they are; the new row and the border colour need no setting of their own.
- Clear Chat 0.15.4.1 needs Paseo 0.14.0 or later and was tested on Paseo 0.15.4. Upgrade Paseo on the daemon host and on every connected app before updating the plugin.
- This release was checked on isolated hosts with a synthetic provider, not with real models; real devices and the native phone apps were not verified.

## [0.15.3.6] - 2026-11-09

### Changed

- The answer card is a frame beneath the latest assistant reply, in the reply text column at desktop and phone widths; choose there or type in Paseo's normal input box. The existing answer-card setting still controls it, and **Assistant markdown** must be on ([#366](https://github.com/jasonhnd/paseo-clear-chat/issues/366), [#371](https://github.com/jasonhnd/paseo-clear-chat/issues/371), [PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).
- Choosing an unanswered question moves to the next unanswered one; the last choice (or a single-question choice) focuses **Send**. Revisiting and changing an answered question keeps that question open. Tabs show short question names or `✓` with an answered question's chosen text; Send names any missing answer and stays disabled until all questions are answered ([#364](https://github.com/jasonhnd/paseo-clear-chat/issues/364), [#368](https://github.com/jasonhnd/paseo-clear-chat/issues/368), [PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).
- After sending from the frame or sending a typed answer, the old frame remains grey and read-only with `Answered in the chat: …`, without Send or a key hint. A later reply can have its own operable frame. **Not options** dismisses a false detection and remembers it after reload ([#369](https://github.com/jasonhnd/paseo-clear-chat/issues/369), [#382](https://github.com/jasonhnd/paseo-clear-chat/issues/382), [PR #383](https://github.com/jasonhnd/paseo-clear-chat/pull/383), [PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).
- Typing uses Paseo's own input box. Chosen letters are intentionally no longer added to typed text automatically; include them yourself when needed. Selection keys act only within the focused frame and do not take arrow keys from the input box ([#366](https://github.com/jasonhnd/paseo-clear-chat/issues/366), [#369](https://github.com/jasonhnd/paseo-clear-chat/issues/369), [PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)). With focus inside the frame, press an option letter `A–H` (case-insensitive) to choose it directly, with the same auto-advance to the next unanswered question as a click; the last answer focuses Send, and changing an answered question stays there. Letter shortcuts do not act with Ctrl, Alt, Meta or Shift held, during IME composition, on a read-only frame, while sending or the agent is running, for a letter absent from the current question, or with focus in the input box ([#380](https://github.com/jasonhnd/paseo-clear-chat/issues/380), [PR #389](https://github.com/jasonhnd/paseo-clear-chat/pull/389)).

### Removed

- The **Open questions: N** pill above the input box and its question popover, including the bottom sheet at phone width ([PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).
- The card's **Collapse** / reopen controls, its collapsed summary strip, and the **Options detected in the last reply** heading ([PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).
- The own-answer entry and note input inside the card; there is no **Or type your own answer…** row in the new frame. Type and send in Paseo's own input box instead ([PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).
- Number-key (`1–8`) shortcuts for choosing options, left/right arrow shortcuts for changing questions, and Esc to close the question popover. Now click or Tab into an option row, use ↑/↓ to move and Enter to choose; Tab moves between focusable controls rather than acting as a next-question shortcut ([PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).
- Automatically putting selected letters before a typed answer when it is sent; include any letters you need yourself ([PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).

### Known limitations

- At phone width, Enter in Paseo's own input box inserts a newline; use its Send button. This was also observed with the previous release and with Clear Chat disabled, so it is host behaviour, not a regression from this change. This change was checked only with synthetic providers on isolated hosts, not real-model acceptance ([PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).
- Existing limitations for other features remain; see the README ([PR #367](https://github.com/jasonhnd/paseo-clear-chat/pull/367)).

## [0.15.3.5] - 2026-11-09

### Added

- The answer card splits a reply by `A3`-style question numbers: a reply that numbers its questions with a capital letter and digits (`A3 …`, and the bold `**A3**` form too) is read question by question, and each question's own `A`/`B`/`C` options are read; before, such a reply was read as one long run of options and no card appeared ([issue #353](https://github.com/jasonhnd/paseo-clear-chat/issues/353), [PR #355](https://github.com/jasonhnd/paseo-clear-chat/pull/355)). An option list that does not start at `A` or that skips a letter is read as well ([issue #337](https://github.com/jasonhnd/paseo-clear-chat/issues/337), [PR #346](https://github.com/jasonhnd/paseo-clear-chat/pull/346)), and **Not options** still dismisses a list that only looks like options.
- Esc closes the question popover at 390 px, where the key reaches the page: the popover opened from the question pill closes and the input box gets the focus back, as at desktop width ([issue #351](https://github.com/jasonhnd/paseo-clear-chat/issues/351), [PR #352](https://github.com/jasonhnd/paseo-clear-chat/pull/352)).

### Changed

- A dotted option line now needs the neighbouring-line check that the plain-space form already had: with the option-line setting on, a line whose marker is a letter and a dot or a colon (`A.`, `A：` …) keeps its own line only when the line just above or below is the option line of the neighbouring letter, so a lone sentence such as `A. Smith wrote this` stays in its paragraph ([issue #338](https://github.com/jasonhnd/paseo-clear-chat/issues/338), [PR #345](https://github.com/jasonhnd/paseo-clear-chat/pull/345)). The README and the settings table state the rule as it now behaves.

### Internal

- The pre-release check no longer fails on the version file that an install leaves in the checkout ([issue #335](https://github.com/jasonhnd/paseo-clear-chat/issues/335), [PR #347](https://github.com/jasonhnd/paseo-clear-chat/pull/347)).
- `paseo-plugin.json` no longer carries the `translations` block, which the 0.15.3 host ignores; the localised listing text belongs in the plugin-registry submission ([issue #336](https://github.com/jasonhnd/paseo-clear-chat/issues/336), [PR #343](https://github.com/jasonhnd/paseo-clear-chat/pull/343)).
- The answer-card recording in the README was replaced with one recorded at 1280×800 and scaled to 800×500, showing the answers being chosen and Send pressed ([PR #350](https://github.com/jasonhnd/paseo-clear-chat/pull/350), [PR #354](https://github.com/jasonhnd/paseo-clear-chat/pull/354), [PR #356](https://github.com/jasonhnd/paseo-clear-chat/pull/356)).

### Compatibility

- Clear Chat 0.15.3.5 is the Clear Chat release for Paseo 0.15.3.
- The release candidate was checked on an isolated host running Paseo 0.15.3: it installs and loads. The answer card appears on a reply whose questions are numbered `A3`/`A4` and sends the chosen letters, and a lone `A. Smith wrote this` line stays in its paragraph with the option-line setting on. The pre-release check and the manifest change were exercised on the tag-day run. The full test suite (2,111 tests) and the type check pass. Not checked: real model replies, input-method composition, and a run in the native phone apps.

### Known limitations

- At desktop width, in the web page or the desktop app, pressing Space while a jump chip has focus does not scroll: Paseo handles that key first, so the chip does not receive it (Paseo's own buttons behave the same way at that width). Enter and a mouse click work, and at narrow widths Space works too.
- The answer card treats a half-width colon with no space after it as a marker, which the reading behind the option-line setting does not; the two have differed since the card was added and this release does not change that.
- A bold line with trailing spaces after the closing `**` is not taken as an anchor; this can be relaxed in a later release if it gets in the way.
- The limitations listed in the previous release still apply.

## [0.15.3.4] - 2026-11-08

### Added

- **The "Keep each option on its own line" setting reads the markers people actually type.** When the setting is on, a line also keeps its own line when the capital letter is followed by a full-width space (`A　take the first one`), a full-width colon (`A：take the first one`) or a half-width colon and a space (`A: take the first one`); the letter may also be a full-width capital `Ａ` to `Ｈ`, and the dot and bracket forms (`A.`, `B)`, `C）`, `D、`) count as before. A capital letter followed by nothing but a half-width space (`A take the first one`) counts only when a line just above or just below is the next or the previous letter in order, so an ordinary sentence that begins with `A ` is not split from its paragraph on its own. With the setting off the text is drawn exactly as in the previous release. The setting is off by default ([#315](https://github.com/jasonhnd/paseo-clear-chat/issues/315), [PR #319](https://github.com/jasonhnd/paseo-clear-chat/pull/319), [#323](https://github.com/jasonhnd/paseo-clear-chat/issues/323), [PR #327](https://github.com/jasonhnd/paseo-clear-chat/pull/327), [#332](https://github.com/jasonhnd/paseo-clear-chat/issues/332), [PR #333](https://github.com/jasonhnd/paseo-clear-chat/pull/333)).
- **The answer card reads an option written with a full-width space.** An option written `A　take the first one` or `A：take the first one` is now read the way the dot, bracket, `、` and `:` forms already were, so lists typed that way get the card. It is offered on more replies than before; when an ordinary list is taken for options, press **Not options** to dismiss it ([#316](https://github.com/jasonhnd/paseo-clear-chat/issues/316), [PR #320](https://github.com/jasonhnd/paseo-clear-chat/pull/320)).
- **Jump chips on more replies.** A line that is one bold phrase and nothing else now counts as an anchor, so a reply written with bold lead-ins gets a row of chips above it: chips appear from 1,200 characters with at least 2 anchors (before: 3,000 characters with three headings). A bold line counts only when it starts its own paragraph, and the reply marks bold anchors the way it marks headings, so pressing a chip scrolls to the block it was built from. Up to 8 chips, one per anchor, each cut at 24 characters; nothing is folded or removed. It is still drawn in the web page and the desktop app only, not in the native phone apps ([#317](https://github.com/jasonhnd/paseo-clear-chat/issues/317), [PR #321](https://github.com/jasonhnd/paseo-clear-chat/pull/321), [#322](https://github.com/jasonhnd/paseo-clear-chat/issues/322), [PR #325](https://github.com/jasonhnd/paseo-clear-chat/pull/325), [#318](https://github.com/jasonhnd/paseo-clear-chat/issues/318), [PR #329](https://github.com/jasonhnd/paseo-clear-chat/pull/329)).

### Compatibility

- Clear Chat 0.15.3.4 is the Clear Chat release for Paseo 0.15.3.
- The release candidate was checked on an isolated host running Paseo 0.15.3: it installs and loads. With the option-line setting off, a set of fixture replies (lettered lines written with a dot, with a bracket, with a full-width space, with a colon, an ordinary sentence that starts with `A `, lettered lines under a numbered question, and lettered lines inside a quotation and a code fence) gives the same text nodes and the same number of displayed lines as in the previous release, case by case. With the setting on, every marker form listed above keeps its own line and ordinary paragraphs and code fences are unchanged; this was read at desktop width and at 390 px wide, and the page has no horizontal overflow. The settings page still lists 23 settings with their names in English, Chinese and Japanese, and Reset defaults clears them. Jump chips appear on a reply of at least 1,200 characters with two bold anchors and on one with two headings, and pressing a chip scrolls to its block " + M322 + M318 + ". The answer card appears for a reply written with full-width spaces and **Not options** hides it. The full test suite (2,103 tests) and the type check pass. Not checked: real model replies, input-method composition, and a run in the native phone apps.

### Known limitations

- At desktop width, in the web page or the desktop app, pressing Space while a jump chip has focus does not scroll: Paseo handles that key first, so the chip does not receive it (Paseo's own buttons behave the same way at that width). Enter and a mouse click work, and at narrow widths Space works too.
- The answer card treats a half-width colon with no space after it as a marker, which the reading behind the option-line setting does not; the two have differed since the card was added and this release does not change that.
- A bold line with trailing spaces after the closing `**` is not taken as an anchor; this can be relaxed in a later release if it gets in the way.
- The limitations listed in the previous release still apply.

## [0.15.3.3] - 2026-11-08

### Added

- A new setting, "Keep each option on its own line", off by default (English, Simplified Chinese and Japanese; saved and restored like the other settings, cleared by Reset defaults, never imported from a browser snapshot). Clear Chat joins the lines of one paragraph of a reply with a space, so a reply that lists options on separate lines (`A. …`, `B. …`, `C. …`) ran together into one block of text. With the setting on, a line that looks like a lettered option keeps a real line break before it, in three places: in a plain paragraph, in the paragraphs of a quotation, and in the text that continues a list item (for example a numbered question followed by lettered lines). A lettered option line starts, after optional spaces or tabs and optional `*` or `_` marks, with one capital letter from A to H, then `.` or `)` followed by at least one space or tab and then text, or the full-width `）` or `、` followed by text; a closing `*` or `_` right after the marker is allowed, so `**A.** text` counts. Lower-case letters, letters after H and forms such as `e.g.` or `A.B.` do not count, and a line that continues an option line is joined to it with a space as before. Headings, code blocks, rules, tables, lists that start with a marker and quotations are read as before. With the setting off (the default) replies are drawn exactly as in the previous release; replies that are already shown are redrawn after the chat is reloaded, and new replies follow the setting at once ([issue #304](https://github.com/jasonhnd/paseo-clear-chat/issues/304), [PR #308](https://github.com/jasonhnd/paseo-clear-chat/pull/308), [issue #305](https://github.com/jasonhnd/paseo-clear-chat/issues/305), [PR #307](https://github.com/jasonhnd/paseo-clear-chat/pull/307), [issue #306](https://github.com/jasonhnd/paseo-clear-chat/issues/306), [PR #309](https://github.com/jasonhnd/paseo-clear-chat/pull/309)).

### Compatibility

- Clear Chat 0.15.3.3 is the Clear Chat release for Paseo 0.15.3.
- The release candidate was checked on an isolated host running Paseo 0.15.3: it installs and loads. With the setting off, a set of fixture replies (lettered lines one per line, lettered lines under a numbered question, ordinary multi-line paragraphs, lines with `e.g.` and a lower-case `a.`, lettered lines inside a quotation, lettered lines inside a code fence, bold and full-width lettered lines, and a sentence that starts with `A. Smith`) gives the same text nodes and the same number of displayed lines in this release as in the previous release, case by case. With the setting on, each lettered line is on its own line and ordinary paragraphs and code fences are unchanged; this was read at desktop width and at 390 px wide, and the page has no horizontal overflow. The settings page shows the setting name in English, Chinese and Japanese, and it is off by default; the setting is still there after a reload, and Reset defaults turns it off again. The jump chips of the previous release still work in a reply of more than 3,000 characters (a row of 5 chips, and pressing one scrolls to its heading). The full test suite (2,091 tests) and the type check pass. Not checked: real model replies, input-method composition, and a run in the native phone apps.

### Known limitations

- The answer card is off by default, and it works by touch, mouse and keyboard only on the web and desktop; the native phone apps give plugins no key events, so there it works by touch only.
- Key handling and the typed-message prefix rely on the structure of Paseo's page (the marked input box and the chat area). If a Paseo upgrade changes that structure, the keys do nothing and your typed message is sent unchanged, while touch and mouse still work.
- The floating panel relies on the structure of Paseo's page, which a Paseo upgrade can change. When it cannot be placed it is not shown and the card under the reply stays open instead; the panel is tried again the next time the conversation page is shown again (when you switch back to the conversation) or after a reload. A short transient layout, such as a very short window, can also trigger this.
- A plain list can be read as options when it looks like lettered questions with an answer hint or a recommendation; press Not options to dismiss the card.
- On a narrow window (390 px wide), the popover opened from the question pill did not close on Esc in our check; a click outside the popover closes it, and on a wide window Esc closes it. It is not known whether this comes from the host or from Clear Chat.
- With Clear Chat on, Paseo's own Chat display modes (Full, Collapse tool calls, Collapse turns) do not change how the conversations drawn by Clear Chat look, because Clear Chat draws every row itself; it folds finished steps and long output by its own settings. With Clear Chat off, the three modes work as usual.
- At desktop width, in the web page or the desktop app, pressing Space while a jump chip has focus does not scroll: Paseo handles that key first, so the chip does not receive it (Paseo's own buttons behave the same way at that width). Enter and a mouse click work, and at narrow widths Space works too.
- Only a capital letter from A to H counts as an option line for the new setting; lower-case letters, letters after H and forms such as `e.g.` do not.
- The limitations listed in the previous release still apply.

### Upgrading

- Update an existing installation with `paseo plugin update clear-chat --ref v0.15.3.3`; the plugin reloads on its own and the Paseo daemon is not restarted. The new setting is off until you turn it on. Removing a plugin also removes its settings, so back them up before removing.

## [0.15.3.2] - 2026-11-07

### Added

- The "Not options" choice on the answer card is remembered after the chat is reloaded. Before, pressing Not options hid the card only until the chat was reloaded, because the reply is parsed again after a reload. Now the reply is kept in a list in the saved settings on the host: up to 100 replies (each is identified by the agent and the time of the reply), the oldest dropped first. A reply on that list gets no card, no pill and no floating panel after a reload; a newer reply of the same agent is not affected, and two agents do not affect each other. Sending an answer does not add a reply to the list, only the Not options button does. "Reset defaults" empties the list, and a settings snapshot imported from a browser never supplies it. The list is not a visible setting: it has no row on the settings page. If saving fails, the card is still hidden on this page and nothing is shown; a reply that arrives before the saved settings have loaded is removed again when they are ready, so a dismissed card does not show once loading ends ([issue #252](https://github.com/jasonhnd/paseo-clear-chat/issues/252), [PR #287](https://github.com/jasonhnd/paseo-clear-chat/pull/287)).
- A new setting, "Show jump chips on long replies", off by default (English, Simplified Chinese and Japanese; saved and restored like the other settings, cleared by Reset defaults, never imported from a browser snapshot). With it on, a finished reply of at least 3,000 characters with at least three headings (levels 1 to 3, outside fenced code blocks) gets a row of chips above its text: one chip per heading, at most 8, the label cut at 24 characters (with an ellipsis), the row scrolls sideways, and each chip is a button labelled with the heading and at least 44 points high. Pressing a chip scrolls the reply to that heading; if the heading or the scrolling call is not available, nothing happens and no error is shown. No chips are drawn while the reply is still being written, because in our check the host pulled the chat list back to the bottom within a second while the agent was writing; the reply text is never folded, shortened or changed. The chip row is drawn only in the web page and the desktop app; in the native apps nothing is drawn, with the setting on or off, and the reply text is unchanged. With the setting off nothing is drawn ([issue #259](https://github.com/jasonhnd/paseo-clear-chat/issues/259), [PR #292](https://github.com/jasonhnd/paseo-clear-chat/pull/292), [PR #293](https://github.com/jasonhnd/paseo-clear-chat/pull/293), [PR #295](https://github.com/jasonhnd/paseo-clear-chat/pull/295), [issue #296](https://github.com/jasonhnd/paseo-clear-chat/issues/296), [PR #298](https://github.com/jasonhnd/paseo-clear-chat/pull/298)).

### Fixed

- On a phone, the popover opened from the pill (a bottom sheet) keeps the question tabs, with the chosen answers, fixed at its top and the Send row fixed at its bottom, while the question text, the options, Write my own, Next, Not options and the error text scroll in between; the popover's height is limited to a share of the screen height. Before, on a 390 x 844 page the popover was taller than the screen and did not scroll by itself, and the tabs scrolled away with the content. The height limit was lowered once more so that the whole Send row ends inside a phone screen ([issue #294](https://github.com/jasonhnd/paseo-clear-chat/issues/294), [PR #297](https://github.com/jasonhnd/paseo-clear-chat/pull/297)). Touch targets stay at least 44 points; the wide layout, the card under the reply and the floating panel do not change ([issue #258](https://github.com/jasonhnd/paseo-clear-chat/issues/258), [PR #291](https://github.com/jasonhnd/paseo-clear-chat/pull/291)).

### Changed

- The introduction page (OVERVIEW.md and OVERVIEW.zh-CN.md) now says where a pasted image is read from and which data folders are kept. To show a pasted image in the prompt bubble, the server looks the message up in the local conversation records of the provider that runs the chat, read-only and only when exactly one message matches: Codex records under CODEX_HOME (default ~/.codex), Claude records under CLAUDE_CONFIG_DIR (default ~/.claude, the projects folder), and, for a ·CC provider copy, Clear Chat's own image store. It never writes to, copies or locks those records, opens files without following symbolic links, reads only regular image files (png, jpg, jpeg, webp, gif) of at most 8 MiB inside the expected folders, and returns the image only to the Clear Chat page in your Paseo. A ·CC provider copy keeps three things under plugin-data/clear-chat in the Paseo home on the host: a record of the conversation, the images you paste, and the list of model and mode options of that provider. This describes how Clear Chat already worked; no behaviour changed.
- The README table "What a plugin cannot do" now says that, with Clear Chat on, Paseo's own Chat display modes (Full, Collapse tool calls, Collapse turns) do not change the conversations drawn by Clear Chat, and that turning Clear Chat off gives the three modes back. This describes how Clear Chat already worked; no behaviour changed.

### Compatibility

- Clear Chat 0.15.3.2 is the Clear Chat release for Paseo 0.15.3.
- The release candidate was checked on an isolated host running Paseo 0.15.3: it installs and loads; the settings page version line reads 0.15.3.2 in English, Chinese and Japanese; the plugin runs (state running) and the daemon log has no error-level entries; compared with Paseo 0.15.2 the public interface of the plugin and client packages is the same (no export removed). The full test suite (2,073 tests) and the type check pass. The interface was read through item by item in all three languages: failed command steps, a successful command, a failed read, the reasoning card, the time format, the quote panel in dark and light, file paths in inline code, the setting that leaves code blocks to other plugins and the input box. Not checked: real model replies, input-method composition, and a run in the native phone apps.

### Known limitations

- The answer card is off by default, and it works by touch, mouse and keyboard only on the web and desktop; the native phone apps give plugins no key events, so there it works by touch only.
- Key handling and the typed-message prefix rely on the structure of Paseo's page (the marked input box and the chat area). If a Paseo upgrade changes that structure, the keys do nothing and your typed message is sent unchanged, while touch and mouse still work.
- The floating panel relies on the structure of Paseo's page, which a Paseo upgrade can change. When it cannot be placed it is not shown and the card under the reply stays open instead; the panel is tried again the next time the conversation page is shown again (when you switch back to the conversation) or after a reload. A short transient layout, such as a very short window, can also trigger this.
- A plain list can be read as options when it looks like lettered questions with an answer hint or a recommendation; press Not options to dismiss the card.
- On a narrow window (390 px wide), the popover opened from the question pill did not close on Esc in our check; a click outside the popover closes it, and on a wide window Esc closes it. It is not known whether this comes from the host or from Clear Chat.
- With Clear Chat on, Paseo's own Chat display modes (Full, Collapse tool calls, Collapse turns) do not change how the conversations drawn by Clear Chat look, because Clear Chat draws every row itself; it folds finished steps and long output by its own settings. With Clear Chat off, the three modes work as usual.
- At desktop width, in the web page or the desktop app, pressing Space while a jump chip has focus does not scroll: Paseo handles that key first, so the chip does not receive it (Paseo's own buttons behave the same way at that width). Enter and a mouse click work, and at narrow widths Space works too.
- The limitations listed in the previous release still apply, except the one about a card dismissed with Not options appearing again after a reload, which no longer applies.

### Upgrading

- Update an existing installation with `paseo plugin update clear-chat --ref v0.15.3.2`; the plugin reloads on its own and the Paseo daemon is not restarted. The new setting is off until you turn it on. Removing a plugin also removes its settings, so back them up before removing.

## [0.15.3.1] - 2026-11-07

### Added

- A new setting, "Show an answer card under replies that ask lettered questions", off by default. When the latest reply asks numbered questions with lettered options (at least two options per question, starting at A and following without gaps) and either asks for a short-form answer or marks an option as recommended, a card appears under that reply. It has a tab for each question, the options with a Recommended mark, Write my own (a note), Next, Not options, and a Send button that shows the exact text it sends, for example `1B 2A`, and names a question that is still missing. The card is drawn only under the latest reply, only while the agent is not running, and a newer message removes it; a failed send keeps the card and shows the reason. Rows and buttons are at least 44 points high. Questions inside a code block or a quotation are ignored ([issue #235](https://github.com/jasonhnd/paseo-clear-chat/issues/235), [issue #221](https://github.com/jasonhnd/paseo-clear-chat/issues/221), [issue #234](https://github.com/jasonhnd/paseo-clear-chat/issues/234), [PR #242](https://github.com/jasonhnd/paseo-clear-chat/pull/242)).
- Keyboard control of the answer card on the web and desktop. The card takes no keys until it is entered, by a click on the card or the up or down arrow while the input box is empty. Then the arrows move, `A` to `H` and `1` to `8` choose, Enter chooses the highlighted option and goes on (the last Enter sends), Tab or the right arrow goes to the next question (on the last question Tab moves to the Send button) and Shift+Tab or the left arrow goes back, and Esc collapses the card and returns to the input box. As soon as the input box has text, the card collapses and every key goes to the input box; modifier keys and input-method composition are ignored, and keys the card does not use are never blocked ([issue #236](https://github.com/jasonhnd/paseo-clear-chat/issues/236), [PR #246](https://github.com/jasonhnd/paseo-clear-chat/pull/246)).
- A typed message keeps the answers chosen on the card: while the card is available (it collapses by itself as soon as you type), pressing Enter to send your text puts the chosen answers in front of it, followed by a space. The prefix is added only when the input box is not empty, at least one question is chosen, Shift and Alt are not held and no input-method composition is in progress. This works on the web and desktop only; if the text cannot be written or checked, your message is sent unchanged, and if the host does not send within 300 ms the prefix is taken out again. The input box is looked up in the conversation page the card belongs to, so after you have visited another conversation and come back, the chosen answers are still put in front of what you type. ([issue #230](https://github.com/jasonhnd/paseo-clear-chat/issues/230), [PR #245](https://github.com/jasonhnd/paseo-clear-chat/pull/245), [issue #281](https://github.com/jasonhnd/paseo-clear-chat/issues/281), [PR #282](https://github.com/jasonhnd/paseo-clear-chat/pull/282)).
- A pill above the input box reads "Open questions: N", where N is the number of questions not chosen yet, and opens the same picker in a popover (anchored on wide layouts, a bottom sheet on compact layouts) with the full question text, the options, Write my own, Not options and a Send button showing the exact text. Choices are shared with the card. The popover can be opened while the agent is running, with Send disabled. The pill is registered while the answer card is available for the agent and the setting is on, and removed when the session ends, after Not options, when the setting is turned off and when the plugin is unloaded; a host without the composer pill interface, or a failing registration, is ignored without an error ([issue #231](https://github.com/jasonhnd/paseo-clear-chat/issues/231), [PR #249](https://github.com/jasonhnd/paseo-clear-chat/pull/249)).
- A floating answer panel above the input box on the web and desktop, behind the same setting. It has the same content, key handling and Send path as the card, and while it is shown the card under the reply is hidden. The panel is drawn through the structure of Paseo's page, so it falls back to the card, for that card mount only, when the input box is not found or is not the marked element, is hidden or has no size, lies outside the window or has less than 44 pixels above it, is replaced by another element, or when anything fails while the panel is mounted, drawn or positioned; the check runs on layout changes and every 250 ms. The first click on a button in the panel is no longer lost, because redraws are held while a pointer is down inside the panel. The panel, its Send row and the Send button are drawn on opaque backgrounds (a theme colour with transparency is mixed with the theme's base colour), so the rows underneath do not show through. The panel is hidden while the pill's popover is open and comes back when the popover closes. The Send row sits below the scrolling part of the panel, so Send no longer covers Next, Not options or the option rows; a redraw keeps the scroll position and a new question starts at the top. If the input box is not on the page yet when the card appears, the card looks again every 250 ms for up to 3 seconds; a panel that fell back to the card, because the conversation page was hidden or because of a page structure problem, is tried again each time the conversation page is shown again (switching back to the conversation), and after a reload. The strip of the card, shown when there is no panel, no longer cuts off its text ([issue #229](https://github.com/jasonhnd/paseo-clear-chat/issues/229), [PR #248](https://github.com/jasonhnd/paseo-clear-chat/pull/248), [issue #255](https://github.com/jasonhnd/paseo-clear-chat/issues/255), [PR #256](https://github.com/jasonhnd/paseo-clear-chat/pull/256), [issue #261](https://github.com/jasonhnd/paseo-clear-chat/issues/261), [PR #262](https://github.com/jasonhnd/paseo-clear-chat/pull/262), [issue #263](https://github.com/jasonhnd/paseo-clear-chat/issues/263), [PR #268](https://github.com/jasonhnd/paseo-clear-chat/pull/268), [issue #265](https://github.com/jasonhnd/paseo-clear-chat/issues/265), [PR #269](https://github.com/jasonhnd/paseo-clear-chat/pull/269), [issue #264](https://github.com/jasonhnd/paseo-clear-chat/issues/264), [PR #272](https://github.com/jasonhnd/paseo-clear-chat/pull/272), [issue #267](https://github.com/jasonhnd/paseo-clear-chat/issues/267), [PR #271](https://github.com/jasonhnd/paseo-clear-chat/pull/271), [issue #275](https://github.com/jasonhnd/paseo-clear-chat/issues/275), [PR #277](https://github.com/jasonhnd/paseo-clear-chat/pull/277), [issue #276](https://github.com/jasonhnd/paseo-clear-chat/issues/276), [PR #279](https://github.com/jasonhnd/paseo-clear-chat/pull/279), [issue #281](https://github.com/jasonhnd/paseo-clear-chat/issues/281), [PR #282](https://github.com/jasonhnd/paseo-clear-chat/pull/282)).

### Changed

- A mark such as "（推荐）" or "(recommended)" after an option is recognised as a recommendation, and "not recommended", "non-recommended" and "不推荐" are not; a recommendation in a sentence counts only when it names an upper-case letter A to H ([issue #239](https://github.com/jasonhnd/paseo-clear-chat/issues/239), [PR #241](https://github.com/jasonhnd/paseo-clear-chat/pull/241), [PR #238](https://github.com/jasonhnd/paseo-clear-chat/pull/238)).

- The description of the "Assistant markdown" setting now says to list the code block languages that other plugins draw (for example `mermaid`, and `math` for formulas) under "Leave these code blocks to other plugins", and to turn Assistant markdown off only for images and the host's file-path links ([issue #261](https://github.com/jasonhnd/paseo-clear-chat/issues/261), [PR #262](https://github.com/jasonhnd/paseo-clear-chat/pull/262)).

### Fixed

- An answer card is also created when a reply carries the same millisecond as the user message before it; a reply that is earlier than that message gets none. A user message removes the card only when it is strictly later than the card's reply ([issue #266](https://github.com/jasonhnd/paseo-clear-chat/issues/266), [PR #270](https://github.com/jasonhnd/paseo-clear-chat/pull/270)).

### Compatibility

- Clear Chat 0.15.3.1 is the Clear Chat release for Paseo 0.15.3.
- The release candidate was checked on an isolated host running Paseo 0.15.3, in the web app with a synthetic provider (not a real model): it installs and loads; the settings page version line reads 0.15.3.1 in English, Chinese and Japanese; the full regression suite (2,053 tests) and the type check pass; the page layout passes in 18 cases (six widths, three folding modes) and in 6 sub-agent cases, with no overlap, no covered row, no horizontal scrolling and no jump of the click position at 390 px wide; the earlier product spot checks (the reasoning card, the quote panel, failed command steps, file paths in inline code) still pass; 41 items compared with Paseo 0.15.2 are in the same state; compared with Paseo 0.15.2, the public interface of the plugin and client packages differs only in the version number, and the exports are the same. The answer card and the floating panel were checked the same way on Paseo 0.15.3 and on Paseo 0.15.2, with the same results: after choosing 1B and switching to another conversation and back, twice in a row, the panel came back within 3 seconds with B still chosen, and clicking Next, clicking A and typing a message with Enter sent "1B 2A thanks"; with the input box marker broken, the expanded card stayed and the keys A and B still chose, and after the marker was restored the panel came back after switching away and back; the panel and its Send row are opaque and the Send row covers no row, at 1280 x 1000 and 390 x 844; the collapsed strip in the chat is hidden while the panel is shown. A reply that carries the same millisecond as the user message, or a few milliseconds later, got an answer UI in 8 of 8 new conversations, one at a time and all at once, on both hosts.
- Not checked: real model replies; input-method composition; the native phone and tablet apps (only the web app was tested); the three host folding modes beyond reading back the setting values and some items in each mode; on Paseo 0.15.2, the full regression suite and the page layout.

### Known limitations

- The answer card is off by default, and it works by touch, mouse and keyboard only on the web and desktop; the native phone apps give plugins no key events, so there it works by touch only.
- Key handling and the typed-message prefix rely on the structure of Paseo's page (the marked input box and the chat area). If a Paseo upgrade changes that structure, the keys do nothing and your typed message is sent unchanged, while touch and mouse still work.
- The floating panel relies on the structure of Paseo's page, which a Paseo upgrade can change. When it cannot be placed it is not shown and the card under the reply stays open instead; the panel is tried again the next time the conversation page is shown again (when you switch back to the conversation) or after a reload. A short transient layout, such as a very short window, can also trigger this.
- After you reload the chat, a card you dismissed with Not options appears again.
- A plain list can be read as options when it looks like lettered questions with an answer hint or a recommendation; press Not options to dismiss the card.
- On a narrow window (390 px wide), the popover opened from the question pill did not close on Esc in our check; a click outside the popover closes it, and on a wide window Esc closes it. It is not known whether this comes from the host or from Clear Chat.
- The limitations listed in the previous release still apply.

### Upgrading

- Update an existing installation with `paseo plugin update clear-chat --ref v0.15.3.1`; the plugin reloads on its own and the Paseo daemon is not restarted. The new setting is off until you turn it on. Removing a plugin also removes its settings, so back them up before removing.

## [0.15.2.2] - 2026-11-06

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

[0.15.4.1]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.15.3.6...v0.15.4.1
[0.15.3.3]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.15.3.2...v0.15.3.3
[0.15.3.2]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.15.3.1...v0.15.3.2
[0.15.3.1]: https://github.com/jasonhnd/paseo-clear-chat/compare/v0.15.2.2...v0.15.3.1
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