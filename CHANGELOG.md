# Changelog

All notable changes to Clear Chat are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and each version is the Paseo version it is built and tested for plus one number that counts Clear Chat's releases for that Paseo version, for example 0.12.0.1 for the first release for Paseo 0.12.0. Releases 1.0.0 and 1.0.1 came out before this rule.

## [0.13.1.1] - Unreleased

Built and tested on Paseo 0.13.1. Needs Paseo 0.13.0 or later.

### Added

- Images pasted into a prompt now also show in the prompt bubble for Hermes agents, with **Enhanced prompt bubble** on. When you create a new agent in Paseo, choose the **·CC** version of your Hermes provider, for example **Hermes·PP·CC**. Clear Chat saves the pasted images in its own folder before it passes your prompt to Hermes, unchanged, and shows an image only when it matches the exact message. After Paseo's background service restarts, the images and your original prompt text are still there.
  - Only prompts sent in a **·CC** agent with this version or later show images. Agents you started before, and their old messages, do not.
  - A prompt that is only an image, with no text, does not show the image.
  - If the saved record does not match, has been changed, or you used a slash command or a revert such as `/undo`, Clear Chat falls back to Hermes's own text for that conversation and shows no images.
  - Use one conversation from one window at a time. If a second window sends a prompt to the same conversation, both windows fall back to Hermes's own text.
  - The images take up to 2 GB in Clear Chat's own folder; when it is full, the oldest are deleted first.
- New setting **Hermes·CC providers**, on by default, controls whether the **·CC** versions are added. Changes apply after you reload the host. The **·CC** agents you already created stay in the list, but opening one shows "Failed to load agent" until you turn the setting back on and reload; the conversation is not lost.

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

[0.13.1.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.13.1.1
[0.13.0.2]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.13.0.2
[0.13.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.13.0.1
[0.12.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v0.12.0.1
[1.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v1.0.1
[1.0.0]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v1.0.0
