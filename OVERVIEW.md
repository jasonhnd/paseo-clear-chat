Clear Chat is a Paseo plugin for the answer card. When a reply asks lettered questions, the card lets you pick an option or write your own, preview the answer, and send it. It does not draw the conversation. For the conversation view, use the separate plugin Better Paseo.

The interface text follows the app language: English, Simplified Chinese, or Japanese. The plugin list shows the English description.

## What it does

- Recognises numbered questions with at least two lettered options, plus a recommendation mark or a short-reply hint. A line of its own that names one option, such as `Recommended: A`, also marks that option. Code fences and quotations are ignored.
- The card's controls choose an option, write **Other**, preview a message such as `1B 2A`, and send it. After sending, the card is no longer shown; the message in the chat, such as `1B 2A`, is your answer.
- **Not options** dismisses a false detection and remembers it.
- Saved replies are edited on the settings page. On the card they insert a phrase and do not send.
- A bare letter inside a sentence is not treated as an answer. A numbered token such as `1A` still counts.

After a reply that asks lettered questions has finished, a button above the message box opens the card. It shows the progress, for example **Answer 0/2**; a desktop tooltip and a narrow screen's panel title carry the full name, for example **Answer card · 0/2 answered**. It opens the whole card in a panel, which is a sheet on a narrow screen. In the desktop panel the question area scrolls inside the card, and the progress line and **Send** stay in one row at the bottom, so **Send** is visible without scrolling the panel. Choosing answers updates the count, closing and reopening the panel keeps them, and the button is gone after **Send** until the next such reply finishes. The button belongs to the conversation on screen.

The settings page can be opened.

## Setup

This version needs Paseo 0.16.0 or later. On Paseo 0.15.x it cannot run normally; stay on Clear Chat 0.15.4.x.

Installation runs `npm ci --include=dev --ignore-scripts` on the daemon host, so Node.js and npm must be available there and the host must be able to reach the npm registry.

See the repository README for the install and update commands and for what changed in each release.

If you used Beautiful Chat, its settings file is copied on first start when Clear Chat has none yet. Read the upgrade steps in the repository README before removing Beautiful Chat, because removing a plugin also removes its settings. Copied keys for features this version no longer shows stay in the file and have no control.

## Settings

Open **Settings → Plugins → Clear Chat**. The page heading is **Clear Chat**; the first settings card is titled **Answer card**.

- **Show an answer card under replies that ask lettered questions** is on when no value is stored. A stored value still wins.
- **Saved replies** is one phrase per line. The default phrases are `Go with the recommended`, `Leave it for now`, and `Continue`.
- The installed version is shown in the **Answer card** card. A directory install can show an older version from that directory.
- **Report a problem** opens a GitHub issue form in the browser. Nothing is sent unless you submit it.

Settings are saved on the host and shared by every client connected to it.

## Data and permissions

- Clear Chat does not send conversation content off the host, except the message you send yourself. **Send** on the answer card sends one message, written as you, through Paseo to the agent of the current chat.
- This version does not read local image files, highlight code, or register a provider copy.
- Startup does not delete anything under the plugin data directory. Older image and history directories are left in place and are not used.
- The only network use by Clear Chat itself is `npm ci` at install time.
- **Report a problem** opens a GitHub issue form. Nothing is sent unless you submit it.

## Limitations

- Clear Chat does not draw the conversation. Use Better Paseo for that view.
- `Plan 2B` can still be read as an answer.
- In the desktop panel a long written answer previews in at most two lines: the whole answer index, then the start of the first written answer. The message that is sent keeps the full answer, and the narrow panel shows the full preview.
- A window shorter than about 117 px is not supported: the panel's footer no longer fits.
- While the agent is answering, a card you can still edit has no button, and an open panel says the reply is still running; the button and the answers come back when it ends. A read-only card that is still waiting for your answer keeps its button.
- For up to about half a second after the agent starts answering, the button can still be there; a panel opened in that moment can show the wait message.
- At phone width, Esc does not close the card; tap outside the panel to close it. **Not options** dismisses that reply for good, card and button alike.
- A draft read that fails after the saved preferences are ready, and before a new reply or a new message from you arrives, leaves the card out of reach until one of those arrives or you reload. The draft itself is not lost. A read that finds no draft, or a shape this version rejects, is final and not retried.
- A rollback to the previous release keeps the saved choices but not the continued state: a card you continued asks for **Continue answering** again after a reload.
- This build was checked in the browser interface of Paseo 0.17.4, in a headless browser, at 1280×900, with a test agent that needs no model, on commit b8a43a81 (the code is the same as this build; the commits after it change the version and the documents only). The full set ran in English: the button hiding while the agent answers and returning when it finishes, on the conversation and after switching away and back; a continued card after a reload (the switch away and back was checked for the button, not for the reopen, and both use the same restore path); two quick presses on **Continue answering**; the answer card switched off and on; the card ending after a send; a null drafts block; and an ordinary message with no draft. One pass ran in Chinese, covering the button and a continued card after a reload. The same set also ran on Paseo 0.17.3, with the same result. The version reads 0.17.4.1 in `paseo plugin ls` and on the settings page, and an update from the previous release kept the half-answered draft and the settings. It was not checked in the desktop app, with a real model, on physical iOS or Android devices, on Paseo 0.16.x, 0.17.1 and 0.17.2, in the dark theme, in other interface languages, or at other viewport sizes. A draft store that fails its first read was exercised by unit tests only, not on a real host.
- Removing the plugin deletes its settings. Back them up first.

The repository README has the answer-card steps and troubleshooting.
