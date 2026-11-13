Clear Chat changes how agent conversations look in Paseo, so an answer is easy to find. It does not change what agents do.

It is a display layer, not a provider. Finished steps fold into one row each, every tool call gets its own card, replies keep their code, links and paths, and the answer card lets you write an answer to each question in the conversation. The interface text follows the app language: English, Simplified Chinese or Japanese.

## What's new in 0.15.4.2

- **Easier to find on the plugin list.** The one-line description on the listing page now names the answer card.
- **The Recommended badge is readable in the dark theme.** Its text contrast rose from 2.36:1 to 12.99:1; the light theme stays at 4.63:1.
- **Steady under the answer card.** The hint line keeps a fixed height, so the card no longer shifts when the hint text changes.

## What it does

- Finished steps fold into one short row each: icon, summary and status. The reply that ends a turn stays open.
- Each tool kind Paseo reports gets its own card, including shell commands, file reads and edits, search, subagents, MCP calls and approvals. Claude, Codex and Hermes calls are all supported.
- Opening a folded step shows its details: a bottom sheet on phones, a popover on tablets and a side panel on desktop. Details include the full input and output, and the exit code or duration when the agent reports them.
- Replies get code highlighting with line numbers, clickable links and file paths, and folding for long code and long prompts.
- Any message that contains text can be quoted and answered.
- On a browser or the desktop app, steps can be moved between and opened with the keyboard.
- Code blocks and tool rows can be left to other plugins when you use more than one, and the settings page shows the version of the installed build so a bug report can name it.

## Performance

Measured 2026-11-04 on a 300-step conversation (150 tool calls), three runs per state, on a 4-core, 8 GB cloud test machine with Playwright's Chromium, Clear Chat at commit `bcf896b7`: first screen 673–843 ms with Clear Chat on, 387–444 ms with it off. Native Paseo is quicker because it folds the whole turn into one row; Clear Chat shows each step, and that is what it is for. The repository README documents the method and the runner.

## Setup

Clear Chat 0.16.0 needs Paseo 0.16.0 or later. On Paseo 0.15.x the host refuses to install or update this version; if you are on Paseo 0.15, stay on Clear Chat 0.15.4.2.

Installation runs `npm ci` on the daemon host, so Node.js and npm must be available there and the host must be able to reach the npm registry.

If you used Beautiful Chat, its settings are copied over on first start. Read the upgrade steps in the repository README before removing Beautiful Chat, because removing a plugin also removes its settings.

## Settings

Open **Settings → Plugins → Clear Chat** to choose the accent colour, interface and code fonts, text size, folding, what happens when a folded step is pressed, the answer card, and which code blocks or tool rows are left to other plugins. Settings are saved on the host and shared by every device connected to it.

## Data and permissions

- Clear Chat reads the conversation that Paseo already shows and changes only how it is displayed. It does not send conversation content off the host, to agent providers or to any other service. An image in a reply that points to a web address is loaded by the app or browser from that address, as in a web page. Clicking a link in a reply opens it in your browser or the matching app.
- The messages you send yourself are the exception: **Send** on the answer card sends one message, written as you, for example `1B 2A`, to the agent of the current chat, and a quote reply sends the quoted text and your reply as one message. Both go through Paseo to that agent's provider like any message you type. Clear Chat sends nothing to any other place.
- The answer card requires **Assistant markdown**. The letters you choose are never added to a message automatically; a written answer is sent as you typed it.
- With a **·CC** provider copy, Clear Chat saves the images you paste, a record of the conversation and the list of model and mode options of that provider in its plugin data folder in your Paseo home on the host, so that it can show the images later; your prompt is passed to Hermes unchanged.
- To show a pasted image in the prompt bubble, the server looks the message up in the local conversation records of the provider that runs the chat, read-only and only when exactly one message matches: Codex records under `CODEX_HOME` (default `~/.codex`), Claude records under `CLAUDE_CONFIG_DIR` (default `~/.claude`, the projects folder), and, for a **·CC** provider copy, Clear Chat's own image store. It never writes to, copies or locks those records, opens files without following symbolic links, reads only regular image files (png, jpg, jpeg, webp, gif) of at most 8 MiB inside the expected folders, and returns the image only to the Clear Chat page in your Paseo.
- On the host, its daemon process reads local image files that a conversation refers to, so they can be shown, highlights code locally, and opens a file in the host's file manager when you ask it to. Settings are stored on the host in Paseo's plugin settings folder.
- The only network use by Clear Chat itself is at installation, when `npm ci` downloads its dependencies from the npm registry.
- **Report a problem** in the settings opens a GitHub issue form in your browser. Nothing is sent unless you submit that form yourself.

## Limitations

Clear Chat changes only how Paseo shows a conversation; the repository README lists every limit with what you can do today and what would have to change upstream. In short:

- Interface text follows the app language in English, Simplified Chinese and Japanese.
- On the iOS and Android apps, code uses the system monospace font, and hardware keyboard shortcuts for steps are not available.
- In the iPhone app you cannot long-press to select text in paragraphs containing links or in step summaries; use the reply's **Copy** button to copy the whole reply.
- After you confirm an answer, Paseo scrolls the conversation to the bottom. If you had scrolled up above the answer card, you are taken back to the bottom. This is Paseo's own behaviour after the content changes; the plugin cannot prevent it.
- In the read-only answer frame, Space on a focused question tab does not switch questions because Paseo handles that key first; click the tab or press Enter instead.
- When a code block is drawn by Paseo, its own **Copy** button is about 22 × 22 px on a phone-width screen and does not include trailing blank lines; the plugin interface offers no way to resize that button.
- Pasted images in your original Hermes agents need the **·CC** provider copy, because Paseo removes the images before a plugin sees them.
- At phone width, Enter in Paseo's input box inserts a newline; use its Send button. This is host behaviour and was also seen with the previous release and with Clear Chat disabled.
- This release was checked on isolated hosts with a synthetic provider, not with real models; real devices and the native phone apps were not verified.
- Removing the plugin deletes its settings; back them up first.
