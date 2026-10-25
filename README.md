<p align="right"><b>English</b> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a></p>

<h1 align="center">Clear Chat</h1>

<p align="center"><b>A Paseo plugin that makes agent chats easy to read.</b></p>

<p align="center">
  <a href="https://github.com/jasonhnd/paseo-clear-chat/releases"><img alt="Version" src="https://img.shields.io/github/v/tag/jasonhnd/paseo-clear-chat?label=version&sort=date"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://paseo.sh"><img alt="Paseo 0.13.0+" src="https://img.shields.io/badge/Paseo-%3E%3D0.13.0-5b5bd6"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/compare-dark.png">
    <img alt="The same conversation without the plugin (left) and with Clear Chat (right)" src="images/compare-light.png">
  </picture>
</p>

<p align="center"><sub>Left: the same conversation without the plugin. Right: with Clear Chat. Every screenshot uses sample data.</sub></p>

## Why Clear Chat

- **See the answer first.** Finished steps fold into one compact row each: icon, summary, status, and time when the agent reports it. The reply that ends the turn always stays open.
- **Every agent, drawn right.** Claude, Codex and Hermes calls all get proper cards. All 12 tool kinds that Paseo reports have their own card, and Hermes tools such as `skill_view` and `memory` get dedicated rows. In replays of real conversations, no card is empty.
- **Nothing gets lost.** Your Beautiful Chat settings move over unchanged, and a failed call shows why it failed.
- **Maintained.** Version 1.0.0 closes seven open issues and pull requests reported against the original plugin. Problems go to GitHub Issues, and every release is listed in the [changelog](CHANGELOG.md).
- **Fast.** In our test, a 221-step conversation shows its first screen in about 1.3 seconds, about the same as Paseo without the plugin (also about 1.3 seconds). Scrolling a long conversation stays smooth, with no stutter.<sup>1</sup>

<sub>1. Median of five runs in headless Google Chrome on one machine. Your numbers will differ. The method is in [scripts/perf/README.md](scripts/perf/README.md).</sub>

## Install

```bash
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref v0.13.0.1
```

Clear Chat needs Paseo 0.13.0 or later. Still on Paseo 0.12? Install Clear Chat 0.12.0.1 instead by using `--ref v0.12.0.1`.

Then open **Settings → Plugins → Clear Chat** to choose colours, fonts and folding.

**Version numbers.** A Clear Chat version is the Paseo version it is built and tested for, plus one more number that counts Clear Chat's releases for that Paseo version. For example, 0.12.0.1 is the first Clear Chat release for Paseo 0.12.0, and 0.12.0.2 would be the next. After Paseo releases a new version, the next Clear Chat release starts counting again: 0.12.1.1 for Paseo 0.12.1, or 0.13.0.1 for Paseo 0.13.0. Clear Chat does not release a new version just because Paseo did. Releases 1.0.0 and 1.0.1 came out before this rule; 0.12.0.1 is newer than both.

> [!IMPORTANT]
> Already using Beautiful Chat? Read [Upgrading from Beautiful Chat](#upgrading-from-beautiful-chat) **before** you install or remove anything. Removing a plugin in Paseo also deletes its settings.

## Upgrading from Beautiful Chat

1. **Back up** your Beautiful Chat settings.
2. **Install Clear Chat** while Beautiful Chat is still installed. On first start, Clear Chat copies your settings.
3. **Check** that your settings look right, then remove Beautiful Chat.

<details>
<summary><b>Exact commands, rollback, and how the migration works</b></summary>

The commands use `PASEO_HOME` and fall back to `$HOME/.paseo`. If your daemon uses only `--home`, set `PASEO_HOME` to that path first. Stop if a backup or check fails.

**1. Back up**

```bash
legacy_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-beautiful-chat-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${PASEO_HOME:-$HOME/.paseo}/backups"
cp -a "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat" "$legacy_backup"
```

**2. Install**

```bash
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref v0.13.0.1
```

**3. Check, then remove the old plugin**

Confirm that `${PASEO_HOME:-$HOME/.paseo}/plugin-settings/clear-chat/presentation.json` exists and matches `$legacy_backup/presentation.json`. An existing Clear Chat settings file is never overwritten. If the file is missing or differs, keep Beautiful Chat and the backup, and check the migration error in the log.

```bash
paseo plugin remove beautiful-chat
```

Keep the backup.

**Rollback**

Back up Clear Chat's current settings, then remove it:

```bash
clear_chat_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-clear-chat-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${PASEO_HOME:-$HOME/.paseo}/backups"
cp -a "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/clear-chat" "$clear_chat_backup"
paseo plugin remove clear-chat
```

If Beautiful Chat's settings folder is gone, restore it from the upgrade backup. Replace `YYYYMMDD-HHMMSS` with your backup's timestamp. An existing folder is never overwritten.

```bash
legacy_backup="${PASEO_HOME:-$HOME/.paseo}/backups/plugin-settings-beautiful-chat-YYYYMMDD-HHMMSS"
test ! -e "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat" &&
  cp -a "$legacy_backup" "${PASEO_HOME:-$HOME/.paseo}/plugin-settings/beautiful-chat"
```

Then install the last Beautiful Chat version:

```bash
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref 2bf25e8
```

Changes made in Clear Chat do not sync back to Beautiful Chat. Keep both backups.

**How the migration works**

- On first start, the server copies Beautiful Chat's `presentation.json` into Clear Chat's settings folder if Clear Chat has none yet. It never deletes or overwrites either file.
- If copying fails, the error is logged with both paths, and Clear Chat starts with default settings. The next start tries again.
- Settings are then upgraded from version 1 to version 2. Your choices stay; the two new folding settings start at their defaults.
- In a browser, older preferences stored in the browser are imported once. Settings saved on the host always win.
- Migration expects the default installation IDs. An installation with a custom `--id`, or a daemon home set only with `--home`, needs its settings copied by hand.

</details>

## Features

### Tool calls

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-bash-dark.png"><img alt="Shell and Git" src="docs/images/tool-bash-light.png"></picture><br>**Shell and Git.** Terminal frame, highlighted command, exit code, and time when the agent reports it. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-read-dark.png"><img alt="Read" src="docs/images/tool-read-light.png"></picture><br>**Read.** Language icon, line numbers, copy button. The file name shows the file in your file manager. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-edit-dark.png"><img alt="Edit" src="docs/images/tool-edit-light.png"></picture><br>**Edit.** A clean diff, also built from old and new text when no diff is given. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-image-dark.png"><img alt="Images" src="docs/images/tool-image-light.png"></picture><br>**Images.** Read and generated images appear inline, with size and a clickable source. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-thinking-dark.png"><img alt="Reasoning tool" src="docs/images/tool-thinking-light.png"></picture><br>**Reasoning tool.** Live thinking text, token count and numbered steps. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-mcp-dark.png"><img alt="MCP" src="docs/images/tool-mcp-light.png"></picture><br>**MCP.** Server, transport, inputs and response, all highlighted. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-eval-dark.png"><img alt="Eval" src="docs/images/tool-eval-light.png"></picture><br>**Eval.** Each cell's code, then what it printed. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-ask-dark.png"><img alt="Ask" src="docs/images/tool-ask-light.png"></picture><br>**Ask.** Options with the recommended one and the chosen answer marked. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-task-dark.png"><img alt="Task" src="docs/images/tool-task-light.png"></picture><br>**Subagents.** Name, type, model and the task it was given. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/hub-dark.png"><img alt="Hub" src="docs/images/hub-light.png"></picture><br>**Hub.** Process, message and job cards for every hub operation. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/paseo-dark.png"><img alt="Paseo tools" src="docs/images/paseo-light.png"></picture><br>**Paseo tools.** Paseo's mark, with the provider's mark on created agents. | |

Search, fetch and web search, plans and checklists, plain text, skills and any other tool also get their own cards. An unknown tool shows its name, its inputs as `name: value` and a preview of its output. It is never an empty box.

### Conversation

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/reasoning-dark.png"><img alt="Reasoning trace" src="docs/images/reasoning-light.png"></picture><br>**Reasoning trace.** Collapsible steps with time per step and a token total. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tasks-dark.png"><img alt="Checklist" src="docs/images/tasks-light.png"></picture><br>**Checklist.** Phase, status per task and the reason a task is blocked. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/approval-dark.png"><img alt="Approval" src="docs/images/approval-light.png"></picture><br>**Approvals.** Risk, the exact command and target. Past approvals stay as short status rows. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/user-dark.png"><img alt="Prompt bubble" src="docs/images/user-light.png"></picture><br>**Prompt bubble.** Copy button and token usage. |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/syntax-dark.png"><img alt="Syntax block" src="docs/images/syntax-light.png"></picture><br>**Code.** Language detection, line numbers, diff colours and a full-source copy. | |

### Also included

- **Step details.** Click a collapsed step to see everything about it: the full input and output, the exit code of a shell command, and how long it took when the agent reports it. Input and output have separate copy buttons, and a failed step shows its error text, which you can copy too. Very long output, even 10,000 lines, scrolls smoothly. Details open in a bottom sheet in windows narrower than 744px, a popover from 744 to 1023px, and a side panel from 1024px. When you resize the window, rotate an iPad or use Split View, the details move to the matching layout and keep the same step, your reading position and what you had open. When you switch to another step, its details start at the top. New output for the step you are reading keeps your place. To open steps inside the conversation instead, set **When a collapsed step is pressed** to **Expand inline**.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/ipad-popover-dark.png">
    <img alt="On an iPad-sized window, the cart.ts edit opens in a floating sheet over the demo conversation" src="docs/images/ipad-popover-light.png">
  </picture>
</p>

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/ipad-side-dark.png">
    <img alt="On a wide iPad window, the demo conversation stays on the left and the cart.ts edit opens in the side panel" src="docs/images/ipad-side-light.png">
  </picture>
</p>

- **Keyboard.** In a browser or the desktop app, press Tab to reach a step, Up and Down to move between steps, Enter to open its details and Escape to close them and return to where you were. Typing in text fields works as usual. This also works in an iPad browser with a hardware keyboard. The native iPhone, iPad and Android apps keep touch controls only, because the plugin API does not give plugins hardware keys there.
- **Hover preview.** With a mouse, rest the pointer on a collapsed step for a moment to see a preview of its summary and result. File reads show up to 6 lines. Touch screens do not show previews.
- **Step menu.** Right-click a step, or long-press it on a touch screen, for **Copy command**, **Copy path**, **Copy result** and **Open in file manager**. Each item appears only when it applies; the text written by Write and Edit is not copied as a result. The menu opens next to your pointer or finger and flips to the other side near a screen edge.
- **Compact on phones.** On phone-width screens, titles, status text, icons and padding are smaller, so more steps fit on one screen. Buttons stay easy to tap.
- **Folding you control.** Click an open row to close it. Click a closed row to open its details, or to open it in place with **Expand inline**. Running, failed and waiting calls open by default. Once you open or close a row, Clear Chat remembers your choice, even after reloads. Long tool output, long code blocks in replies and long prompts show the first 15 lines, with **Show all N lines**. **Copy** always copies the full text.
- **Wrap-up replies.** Replies sent through a `wrap_up` tool show as a full reply card, with recap, question, lettered options and a **Blocked** alert.
- **Clickable links.** Links in replies, including bare web addresses and image addresses, open on desktop, web and iOS, and `mailto:` links open your mail app.
- **Find in chat.** Ctrl/Cmd+F opens a find bar that also searches tool cards. It searches the messages that are loaded, so scroll up to include older ones.
- **Open files.** File names in cards and paths in replies show the file in Finder, Explorer or your file manager on the host computer. On phones, tablets and narrow web windows, paths in replies are copied to the clipboard instead, with a hint to open them on the host. Put a file name or path that contains spaces in inline code, or use a Markdown link.
- **Highlight text.** `==marked text==` highlights text in replies. Inside code, the equals signs stay as they are.

## Settings

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png"><img alt="Settings screen" src="docs/images/settings-light.png"></picture>

| Setting | Effect |
|---|---|
| Accent colour | Follow the Paseo theme, pick Jade, Violet, Amber or Rose, or choose **Custom** for colour swatches and a HEX field. Custom colours are adjusted to keep text contrast at 4.5:1 or higher. |
| Interface font | Embedded Inter, or your system font. |
| Text size | Small (90%), Default (100%), Large (115%) or XL (130%). Icons keep their size. |
| Code glyphs | Iosevka with ligatures, or plain glyphs. |
| Code font | Default (Iosevka) (default), Iosevka, Menlo, Consolas, Fira Code or Cascadia Code. Applies to code blocks, inline code, terminal output and diffs. |
| Fold finished steps | On by default. Off opens every step unless you chose otherwise for that call. |
| When a collapsed step is pressed | Open details (default) shows the step in a sheet, popover or side panel. Expand inline opens it inside the conversation. |
| Fold long output after | 10, 15 (default) or 30 lines, or Never. Applies to tool output, code blocks in replies and prompts. Lines are counted in the source text, so wrapped lines do not count extra. |
| Frosted glass | Blur card backgrounds, or paint them solid. |
| Enhanced prompt bubble | Styles your prompts. Off uses Paseo's own bubble. |
| Assistant markdown | Off hands replies back to Paseo's own renderer. |

**Custom accent colour.** Tap a swatch, or enter `#RGB` or `#RRGGBB` and press **Apply**. An invalid HEX value stays in the field with an error, and the saved colour does not change. Switching to a preset remembers your custom colour. The saved HEX value never changes; only the colour you see is darkened on light themes or lightened on dark themes when text would otherwise be hard to read. Filled buttons use black or white text, whichever has more contrast.

**Code font.** The plugin SDK does not give plugins Paseo's own code font setting. **Default (Iosevka)** uses Iosevka with your **Code glyphs** choice. On web and desktop, the other fonts must be installed on your computer; if one is missing, the embedded Iosevka is used. On iOS and iPadOS, code always uses Menlo, and on Android it uses the system monospace font, because the plugin SDK does not let plugins add fonts to the native apps.

Clear Chat's own text follows the Paseo app language: English, Simplified Chinese or Japanese. Settings are saved on the host, so every device connected to that host shares them. Accent colours, folding and step-click settings apply at once, including to rows already shown. Other changes apply to new messages; reload the chat to update older ones.

> [!NOTE]
> **On iOS and iPadOS** you cannot select text by dragging while **Assistant markdown** or **Enhanced prompt bubble** is on. Use the **Copy** button on the reply, prompt or code block instead. If copying fails, a dialog shows the full text for you to select by hand.

## Troubleshooting

| Problem | What to do |
|---|---|
| Installing through the Cafe plugin fails, or Paseo reports a missing Shiki dependency such as `@shikijs/core`. | Retry with the Paseo CLI command in [Install](#install), using the same repository and release ref. Clear Chat installs its dependencies with `npm ci --include=dev`, so Node.js and npm must be available on the daemon host, and its network must reach the npm registry. If you manage the checkout yourself, run `npm ci --include=dev` there before retrying. |
| Installation stops with `Plugin "clear-chat" requires Paseo >=0.13.0. Your daemon is 0.12.x.` (or `Your app is …`). | Update Paseo on the daemon host and in every connected app to 0.13.0 or later. To stay on Paseo 0.12, install Clear Chat 0.12.0.1 with `--ref v0.12.0.1`. |
| Images you pasted into a prompt do not show in the prompt bubble. | The images are still sent to the agent. Paseo 0.13 does not pass them to plugins, so Clear Chat's **Enhanced prompt bubble** cannot show them. To see them in the conversation, turn off **Enhanced prompt bubble** in **Settings → Plugins → Clear Chat**; Paseo's own bubble is used instead. |
| Paseo rejects the plugin version, or Clear Chat says plugin settings or timeline support is missing. | Update Paseo on the daemon host and in every connected app, then reload Clear Chat. The Paseo version Clear Chat needs is declared in `paseo-plugin.json`. |
| Clear Chat cannot start because plugin registration failed. | Update Paseo and reload Clear Chat. If it still fails, back up the plugin settings before you reinstall from the CLI. |
| Clear Chat cannot read its settings from the host. | Reconnect to the host and choose **Retry** in **Settings → Plugins → Clear Chat**. If it still fails, check that the daemon can access the plugin settings folder. |
| Clear Chat says its settings are invalid or in an unsupported format. | Back up the settings first. Restore a valid backup, or repair the settings file on the daemon host, then choose **Retry**. Clear Chat never erases the file by itself. |
| Clear Chat cannot save settings. | Check write permission and free disk space on the daemon host, reconnect, then make the change again. **Retry** reloads the settings; it does not resend a change that failed. |
| Settings keep changing because of another client. | Wait until the other edits finish, then make the change again. |
| Beautiful Chat settings were not migrated. | Keep Beautiful Chat's original settings and back them up. Check read and write access to both plugin settings folders and free disk space, then reload Clear Chat to try again. A failed migration leaves a recovery message in the daemon log; existing settings are never overwritten. |

If Paseo cannot run the build command or load the plugin bundle, Clear Chat cannot show a message of its own. Check Node.js, npm and the Paseo version on the daemon host, then retry from the CLI. If the problem stays, use **Report a problem** in the plugin settings and include the recovery message and your Paseo version. Remove private paths and conversation content before you share any logs.

## Reporting problems

Something wrong, or an idea? [Open an issue on GitHub](https://github.com/jasonhnd/paseo-clear-chat/issues/new/choose). You can also use **Report a problem** at the bottom of the settings page. Chinese and Japanese are welcome too.

## Credits

Clear Chat is based on [Beautiful Chat](https://github.com/ABorakati/beautiful-chat) by ABorakati, under the MIT License. The original copyright notice is kept in [LICENSE](LICENSE).

Thanks to Moyf for the [text size contribution](https://github.com/ABorakati/beautiful-chat/pull/9), adapted here to host settings.

For developers: build steps, project layout and the Paseo plugin SDK limits found along the way are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE)
