<p align="right"><b>English</b> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a></p>

<h1 align="center">Clear Chat</h1>

<p align="center"><b>A Paseo plugin that makes agent chats easy to read.</b></p>

<p align="center">
  <a href="https://github.com/jasonhnd/paseo-clear-chat/releases"><img alt="Version" src="https://img.shields.io/github/v/tag/jasonhnd/paseo-clear-chat?label=version&sort=semver"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://paseo.sh"><img alt="Paseo 0.8.0+" src="https://img.shields.io/badge/Paseo-%3E%3D0.8.0-5b5bd6"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/compare-dark.png">
    <img alt="The same conversation without the plugin (left) and with Clear Chat (right)" src="images/compare-light.png">
  </picture>
</p>

<p align="center"><sub>Left: the same conversation without the plugin. Right: with Clear Chat. Every screenshot uses sample data.</sub></p>

## Why Clear Chat

- **See the answer first.** Finished steps fold into one compact row each: icon, summary, status and time. The reply that ends the turn always stays open.
- **Every agent, drawn right.** Claude, Codex and Hermes calls all get proper cards. All 12 tool kinds that Paseo reports have their own card, and Hermes tools such as `skill_view` and `memory` get dedicated rows. In replays of real conversations, no card is empty.
- **Nothing gets lost.** Your Beautiful Chat settings move over unchanged, pasted images keep their count, and a failed call shows why it failed.
- **Maintained.** Version 1.0.0 closes seven open issues and pull requests reported against the original plugin. Problems go to GitHub Issues, and every release is listed in the [changelog](CHANGELOG.md).
- **Fast.** In our test, a 221-step conversation shows its first screen in about 1.3 seconds, about the same as Paseo without the plugin (also about 1.3 seconds). Scrolling a long conversation stays smooth, with no stutter.<sup>1</sup>

<sub>1. Median of five runs in headless Google Chrome on one machine. Your numbers will differ. The method is in [scripts/perf/README.md](scripts/perf/README.md).</sub>

## Install

```bash
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref v1.0.0
```

Then open **Settings → Plugins → Clear Chat** to choose colours, fonts and folding.

> [!IMPORTANT]
> Already using Beautiful Chat? Read [Upgrading from Beautiful Chat](#upgrading-from-beautiful-chat) **before** you install or remove anything. Removing a plugin in Paseo 0.12 also deletes its settings.

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
paseo plugin install git:https://github.com/jasonhnd/paseo-clear-chat.git --ref v1.0.0
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
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-bash-dark.png"><img alt="Shell and Git" src="docs/images/tool-bash-light.png"></picture><br>**Shell and Git.** Terminal frame, highlighted command, exit code and time. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tool-read-dark.png"><img alt="Read" src="docs/images/tool-read-light.png"></picture><br>**Read.** Language icon, line numbers, copy button. The file name shows the file in your file manager. |
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
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/approval-dark.png"><img alt="Approval" src="docs/images/approval-light.png"></picture><br>**Approvals.** Risk, the exact command and target. Past approvals stay as short status rows. | <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/user-dark.png"><img alt="Prompt bubble" src="docs/images/user-light.png"></picture><br>**Prompt bubble.** Copy button, token usage and pasted images, such as "3 images attached". |
| <picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/syntax-dark.png"><img alt="Syntax block" src="docs/images/syntax-light.png"></picture><br>**Code.** Language detection, line numbers, diff colours and a full-source copy. | |

### Also included

- **Folding you control.** Click any row to open or close it. Your choice is remembered after reloads. Running, failed and waiting calls open by default. Long output shows the first 15 lines, with **Show all N lines**.
- **Wrap-up replies.** Replies sent through a `wrap_up` tool show as a full reply card, with recap, question, lettered options and a **Blocked** alert.
- **Clickable links.** Links in replies open on desktop, web and iOS, and `mailto:` links open your mail app.
- **Find in chat.** Ctrl/Cmd+F opens a find bar that also searches tool cards. It searches the messages that are loaded, so scroll up to include older ones.
- **Open files.** File names in cards and paths in replies show the file in the host computer's file manager. On phones, tablets and narrow web windows, reply paths copy to the clipboard with a hint to open them on the host. Put filenames or paths with spaces in inline code, or use a Markdown link.
- **Highlight text.** `==marked text==` adds a highlight to replies. Code keeps its literal equals signs.

## Settings

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png"><img alt="Settings screen" src="docs/images/settings-light.png"></picture>

| Setting | Effect |
|---|---|
| Accent colour | Follow the Paseo theme, or pick Jade, Violet, Amber or Rose. |
| Interface font | Embedded Inter, or your system font. |
| Text size | Small (90%), Default (100%), Large (115%) or XL (130%). Icons keep their size. |
| Code font | Follow Paseo (default), Iosevka, Menlo, Consolas, Fira Code or Cascadia Code. Applies to code blocks, inline code, terminal output and diffs. |
| Code glyphs | Iosevka with ligatures, or plain glyphs. |
| Fold finished steps | On by default. Off opens every step unless you chose otherwise for that call. |
| Fold long output after | 10, 15 (default) or 30 lines, or Never. Applies to code and tool output. |
| Frosted glass | Blur card backgrounds, or paint them solid. |
| Enhanced prompt bubble | Styles your prompts. Off uses Paseo's own bubble. |
| Assistant markdown | Off hands replies back to Paseo's own renderer. |

Settings are saved on the host, so every device connected to that host shares them. The folding settings apply at once. Other changes apply to new messages; reload the chat to update older ones.

Paseo's code font preference is not available through plugin SDK 0.8.0. **Follow Paseo**
therefore falls back to Iosevka with your existing **Code glyphs** choice. On web and desktop,
other font choices use an installed face, with embedded Iosevka as a fallback when it is missing.
On iOS and iPadOS, code uses Menlo; on Android, it uses the platform monospace face because
directory plugins cannot register the embedded web fonts on native platforms.

> [!NOTE]
> **On iOS and iPadOS** you cannot select text by dragging while **Assistant markdown** or **Enhanced prompt bubble** is on. Use the **Copy** button on the reply, prompt or code block instead. If copying fails, a dialog shows the full text for you to select by hand.

## Reporting problems

Something wrong, or an idea? [Open an issue on GitHub](https://github.com/jasonhnd/paseo-clear-chat/issues/new/choose). You can also use **Report a problem** at the bottom of the settings page. Chinese and Japanese are welcome too.

## Credits

Clear Chat is based on [Beautiful Chat](https://github.com/ABorakati/beautiful-chat) by ABorakati, under the MIT License. The original copyright notice is kept in [LICENSE](LICENSE).

Thanks to Moyf for the [text size contribution](https://github.com/ABorakati/beautiful-chat/pull/9), adapted here to host settings.

For developers: build steps, project layout and the Paseo plugin SDK limits found along the way are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE)
