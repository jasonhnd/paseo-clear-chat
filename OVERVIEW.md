Clear Chat is a Paseo plugin for the answer card and **What I said**. When a reply asks lettered questions, the card lets you pick an option or write your own, preview the answer, and send it. **What I said** comes in two shapes: a panel beside the conversation, opened from a workspace header button, and a full screen, opened from a row in the sidebar header, that gathers today's messages from this host's conversations. In both, pressing a row copies that message. It does not draw the conversation. For the conversation view, use the separate plugin Better Paseo.

The interface text follows the app language: English, Simplified Chinese, or Japanese. The plugin list shows the English description.

## What it does

- Recognises numbered questions with at least two lettered options, plus a recommendation mark or a short-reply hint. A line of its own that names one option, such as `Recommended: A`, also marks that option. Code fences and quotations are ignored.
- The card's controls choose an option, write **Other**, preview a message such as `1B 2A`, and send it. After sending, the card is no longer shown; the message in the chat, such as `1B 2A`, is your answer.
- **Not options** dismisses a false detection and remembers it.
- Saved replies are edited on the settings page. On the card they insert a phrase and do not send.
- A bare letter inside a sentence is not treated as an answer. A numbered token such as `1A` still counts.

After a reply that asks lettered questions has finished, a button above the message box opens the card. It shows the progress, for example **Answer 0/2**; a desktop tooltip and a narrow screen's panel title carry the full name, for example **Answer card · 0/2 answered**. It opens the whole card in a panel, which is a sheet on a narrow screen. In the desktop panel the question area scrolls inside the card, and the progress line and **Send** stay in one row at the bottom, so **Send** is visible without scrolling the panel. Choosing answers updates the count, closing and reopening the panel keeps them, and the button is gone after **Send** until the next such reply finishes. The button belongs to the conversation on screen.

The settings page can be opened.

**What I said** opens from a button in the workspace header (the message icon) and sits beside the conversation; when the host cannot place it there, it opens as a main-pane tab. At phone width the button is in the **Workspace actions** sheet and the panel opens full screen. Its top line counts today's machine messages and yours, for example `Machine messages today: 5 · From you: 7`; below it your messages are listed newest first with their local time and up to three lines. Press a row to copy that message exactly as it was sent; a toast confirms it, and the row does not navigate. The panel reads today, re-reads at the next local midnight and on returning to the foreground, and updates while it is open. A day it could not read in full is marked partial with **Try again**; counts from an earlier day are marked stale. Machine messages are counted, not listed.

**The What I said screen** opens from a row in the sidebar header and takes the full width. It lists the messages you typed today across this host's conversations, conversations archived today included: a summary line such as `From you today: 12 · Conversations: 3`, a progress line such as `Reading 3 of 7…`, **Refresh**, and rows with the conversation title, the local time and up to three lines of the body. Pressing a row copies the message exactly as it was sent. A list that was only partly read says it may be incomplete and offers **Try again**; **Refresh** and **Try again** list the conversations again and refill an empty list, and **Try again** gives a conversation that was only partly read or failed a larger page budget; conversations whose history the host could not give back are counted in a line of their own. A screen left open past local midnight says its rows are an earlier day's the next time it is scrolled or pressed, until **Refresh**. Rows appear as each conversation is read. Conversations another agent started are not listed, and neither is anything typed into them directly. At phone width the row is in the sidebar drawer.

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

- **What I said** shows today's messages and nothing earlier: the device's local calendar day.
- The screen lists the conversations on this host whose last message from you is today, archived ones included. Conversations another agent started are not listed, and nothing typed into them directly is listed either.
- Conversations whose provider is unavailable are not listed by the host, so the screen does not read them.
- Some providers cannot give back the history of a conversation restored from storage. Such conversations are counted as unreadable instead of listed, are not cached, and are read again on **Refresh** and **Try again**.
- A total loss of today's history is detected; a partial loss is not reported, and the screen lists what the provider gave back without a warning.
- Reading a conversation that is not loaded makes the daemon load it from storage, which takes time and memory until the daemon's idle cleanup.
- With a real provider (Codex), 20 conversations already loaded were read in 0.38 s; right after a daemon restart, when all 20 had to come back from storage, the same list took 20.4 s, about a second each. A test agent took about 4 s per conversation restored from storage, so another provider can be slower. Measured on Paseo 0.17.4, not a promise for other hosts.
- A screen row copies the message and does not jump back to it.
- A panel row copies the message and does not jump to it: the plugin API has no scroll-to-message surface.
- A machine message is recognised by its leading text, so a message that opens with one of those shapes for another reason is counted as machine and is not listed.
- A day has a page budget. A read that stops short says it is partial and offers **Try again**, and the counts are then a lower bound, at least the number of rows listed. While the panel is open, every timeline event asks for a fresh read of today.
- With several conversations in the workspace and none in front, the **What I said** button does not guess; Paseo shows Clear Chat's message in its own toast.
- At phone width the **What I said** button is in the **Workspace actions** sheet, and the panel covers the conversation while the host's Explorer overlay is open.
- Clear Chat does not draw the conversation. Use Better Paseo for that view.
- `Plan 2B` can still be read as an answer.
- In the desktop panel a long written answer previews in at most two lines: the whole answer index, then the start of the first written answer. The message that is sent keeps the full answer, and the narrow panel shows the full preview.
- A window shorter than about 117 px is not supported: the panel's footer no longer fits.
- While the agent is answering, a card you can still edit has no button, and an open panel says the reply is still running; the button and the answers come back when it ends. A read-only card that is still waiting for your answer keeps its button.
- For up to about half a second after the agent starts answering, the button can still be there; a panel opened in that moment can show the wait message.
- At phone width, Esc does not close the card; tap outside the panel to close it. **Not options** dismisses that reply for good, card and button alike.
- A draft read that fails after the saved preferences are ready, and before a new reply or a new message from you arrives, leaves the card out of reach until one of those arrives or you reload. The draft itself is not lost. A read that finds no draft, or a shape this version rejects, is final and not retried.
- A rollback to the previous release keeps the settings and removes the **What I said** screen, which that release does not have; the panel beside the conversation stays, because that release has it. A rollback to an earlier release keeps the saved choices but not the continued state: a card you continued asks for **Continue answering** again after a reload.
- The browser checks ran in the interface of Paseo 0.17.4, in a headless browser, at 1280×800 and 390×844, with a test agent that needs no model and a real provider (Codex), on commit 0b334a91. For the screen: the sidebar row opens it; rows and conversation titles are right; a row copy is byte-for-byte identical and shows its toast; at 390 wide the row is in the sidebar drawer and the list does not overflow sideways; the panel's button beside the conversation is still there; the console shows no plugin errors; a conversation of the real provider that had been archived still lists its messages after the daemon restarts; and a conversation of the test agent, which cannot replay its history, is counted as unreadable. The release head was smoke-checked; the result is in the repository changelog. It was not checked in the desktop app, on physical iOS or Android devices, on Paseo 0.16.x, 0.17.1, 0.17.2 and 0.17.3, in the dark theme, in other interface languages, or at other viewport sizes.
- Also checked on Paseo 0.17.5: the answer card at 1280×800 and 390×844 and in the Simplified Chinese interface; a half-answered draft and the settings kept across the update from the previous release; the panel beside the conversation; the What I said screen at 1280×800 and 390×844, with its title clear of the sidebar toggle; 6 Codex conversations, 2 of them archived, all listed after a daemon restart; and no plugin errors in the console. How long the screen takes was not measured again on Paseo 0.17.5.
- Removing the plugin deletes its settings. Back them up first.

The repository README has the answer-card and **What I said** steps and troubleshooting.
