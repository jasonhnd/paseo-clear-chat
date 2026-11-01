Clear Chat changes how agent conversations look in Paseo, so the answer is easy to find. It does not change what agents do.

## What it does

- Finished steps fold into one short row each: icon, summary and status. The reply that ends a turn stays open.
- Each tool kind Paseo reports gets its own card, including shell commands, file reads and edits, search, subagents, MCP calls and approvals. Claude, Codex and Hermes calls are all supported.
- Clicking a folded step shows its details: a bottom sheet on phones, a popover on tablets and a side panel on desktop. Details include the full input and output, and the exit code or duration when the agent reports them.
- Replies get code highlighting with line numbers, clickable links and file paths, and folding for long code and long prompts.
- On a browser or the desktop app, steps can be moved between and opened with the keyboard.

## Setup

Clear Chat 0.14.0.4 needs Paseo 0.14.0 or later. For older hosts, see the [README installation guidance](README.md#install), including the untested Paseo 0.13 commands and the separate Paseo 0.12 instructions.

Installation runs `npm ci` on the daemon host, so Node.js and npm must be available there and the host must be able to reach the npm registry.

If you used Beautiful Chat, its settings are copied over on first start. Read the upgrade steps in the README before removing Beautiful Chat, because removing a plugin also removes its settings.

## Settings

Open **Settings → Plugins → Clear Chat** to choose the accent colour, interface font, code font, text size, folding and what happens when you press a folded step. Settings are saved on the host and shared by every device connected to it.

## Data and permissions

- Clear Chat reads the conversation that Paseo already shows and changes only how it is displayed. It does not send conversation content off the host, to agent providers or to any other service. An image in a reply that points to a web address is loaded by the app or browser from that address, as in a web page. Clicking a link in a reply opens it in your browser or the matching app.
- On the host, its daemon process reads local image files that a conversation refers to, so they can be shown, highlights code locally, and opens a file in the host's file manager when you ask it to. Settings are stored on the host in Paseo's plugin settings folder.
- The only network use by Clear Chat itself is at installation, when `npm ci` downloads its dependencies from the npm registry.
- **Report a problem** in the settings opens a GitHub issue form in your browser. Nothing is sent unless you submit that form yourself.

## Limitations

- Interface text follows the app language in English, Simplified Chinese and Japanese.
- On the iOS and Android apps, code uses the system monospace font, and hardware keyboard shortcuts for steps are not available.
- On iOS and iPadOS, text cannot be selected by dragging while the enhanced reply or prompt display is on. Use the Copy buttons instead.
