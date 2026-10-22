# Changelog

All notable changes to Clear Chat are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and each version is the Paseo version it is built and tested for plus one number that counts Clear Chat's releases for that Paseo version, for example 0.12.0.1 for the first release for Paseo 0.12.0. Releases 1.0.0 and 1.0.1 came out before this rule.

## [0.12.0.1] - Unreleased

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

[0.12.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.12.0.1
[1.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v1.0.1
[1.0.0]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v1.0.0
