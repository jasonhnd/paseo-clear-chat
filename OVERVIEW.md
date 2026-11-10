Clear Chat changes how agent conversations look in Paseo, so the answer is easy to find. It does not change what agents do.

It is a display layer, not a provider: every tool kind Paseo reports gets its own card, finished steps fold into one row each, twenty-three settings are saved on the host, and the interface text follows English, Simplified Chinese or Japanese.

## What it does

- Finished steps fold into one short row each: icon, summary and status. The reply that ends a turn stays open.
- Each tool kind Paseo reports gets its own card, including shell commands, file reads and edits, search, subagents, MCP calls and approvals. Claude, Codex and Hermes calls are all supported.
- Clicking a folded step shows its details: a bottom sheet on phones, a popover on tablets and a side panel on desktop. Details include the full input and output, and the exit code or duration when the agent reports them.
- Replies get code highlighting with line numbers, clickable links and file paths, and folding for long code and long prompts. Any message that contains text can be quoted and answered.
- On a browser or the desktop app, steps can be moved between and opened with the keyboard.
- The settings page shows the version of the installed build, so a bug report can name it.
- With the existing answer-card setting on (off by default), lettered questions get a frame below the latest reply in the conversation. Choose by click or keyboard (web and desktop); the first answer advances to the next unanswered question and the last choice focuses **Send**. Tabs show short question names or `✓` with the answer. Sending from the frame or typing and sending in Paseo's input box leaves the old frame grey and read-only. **Not options** dismisses a false detection. Requires **Assistant markdown**.

## Performance

Measured 2026-11-04 on a 300-step conversation (150 tool calls), three runs per state, on a 4-core, 8 GB cloud test machine with Playwright's Chromium, Clear Chat at commit bcf896b7: first screen 673–843 ms with Clear Chat on, 387–444 ms with it off. Native Paseo is quicker because it folds the whole turn into one row; Clear Chat shows each step, and that is what it is for. The README documents the method and the runner.

## Setup

Clear Chat 0.15.4.1 needs Paseo 0.14.0 or later. For older hosts, see the [README installation guidance](README.md#install), including the untested Paseo 0.13 commands and the separate Paseo 0.12 instructions.

Installation runs `npm ci` on the daemon host, so Node.js and npm must be available there and the host must be able to reach the npm registry.

If you used Beautiful Chat, its settings are copied over on first start. Read the upgrade steps in the README before removing Beautiful Chat, because removing a plugin also removes its settings.

## Settings

Open **Settings → Plugins → Clear Chat** to choose the accent colour, interface font, code font, text size, folding and what happens when you press a folded step. Settings are saved on the host and shared by every device connected to it.

## Data and permissions

- Clear Chat reads the conversation that Paseo already shows and changes only how it is displayed. It does not send conversation content off the host, to agent providers or to any other service. An image in a reply that points to a web address is loaded by the app or browser from that address, as in a web page. Clicking a link in a reply opens it in your browser or the matching app.
- The messages you send yourself are the exception: **Send** on the answer card (a setting that is off by default) sends one message, written as you, for example `1B 2A`, to the agent of the current chat, and a quote reply sends the quoted text and your reply as one message. Both go through Paseo to that agent's provider like any message you type. Clear Chat sends nothing to any other place.
- The answer frame handles selection keys only while an option row has focus (web and desktop). To type an answer, use Paseo's own input box; Clear Chat does not add selected letters to typed messages.
- With a **·CC** provider copy, Clear Chat saves the images you paste, a record of the conversation and the list of model and mode options of that provider in its plugin data folder in your Paseo home on the host, so that it can show the images later; your prompt is passed to Hermes unchanged.
- To show a pasted image in the prompt bubble, the server looks the message up in the local conversation records of the provider that runs the chat, read-only and only when exactly one message matches: Codex records under CODEX_HOME (default ~/.codex), Claude records under CLAUDE_CONFIG_DIR (default ~/.claude, the projects folder), and, for a **·CC** provider copy, Clear Chat's own image store. It never writes to, copies or locks those records, opens files without following symbolic links, reads only regular image files (png, jpg, jpeg, webp, gif) of at most 8 MiB inside the expected folders, and returns the image only to the Clear Chat page in your Paseo.
- On the host, its daemon process reads local image files that a conversation refers to, so they can be shown, highlights code locally, and opens a file in the host's file manager when you ask it to. Settings are stored on the host in Paseo's plugin settings folder.
- The only network use by Clear Chat itself is at installation, when `npm ci` downloads its dependencies from the npm registry.
- **Report a problem** in the settings opens a GitHub issue form in your browser. Nothing is sent unless you submit that form yourself.

## Limitations

Clear Chat changes only how Paseo shows a conversation; the README lists every limit with what you can do today and what would have to change upstream. In short:

- Interface text follows the app language in English, Simplified Chinese and Japanese.
- On the iOS and Android apps, code uses the system monospace font, and hardware keyboard shortcuts for steps are not available.
- On iOS and iPadOS, text cannot be selected by dragging while the enhanced reply or prompt display is on. Use the Copy buttons instead.
- Pasted images in your original Hermes agents need the **·CC** provider copy, because Paseo removes the images before a plugin sees them.
- The answer frame requires **Assistant markdown**. At phone width, Enter in Paseo's input box inserts a newline: use its Send button (also observed with the previous release and with Clear Chat disabled). Selected letters are intentionally not added to typed answers. Acceptance for this change used synthetic providers on isolated hosts, not real models.
- Removing the plugin deletes its settings; back them up first.
