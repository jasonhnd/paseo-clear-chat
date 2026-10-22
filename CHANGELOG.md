# Changelog

All notable changes to Clear Chat are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.1]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v1.0.1
[1.0.0]: https://github.com/jasonhnd/paseo-clear-chat/releases/tag/v1.0.0
