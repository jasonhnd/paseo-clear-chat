Clear Chat is a Paseo plugin for the answer card and **What I said**. When a reply asks lettered questions, the card lets you pick an option or write your own, preview the answer, and send it. **What I said** is a full screen, opened from a row in the sidebar header. It is a calendar of the days you typed: a month shaded in four steps, a year of twelve months, and the selected day's messages. The selected day keeps its own step colour, with a thin ring inside the cell. Today is a bold date with a small dot under it. Each month in the year view shows a short name and does not repeat the year. Every row has **Copy** and **Quote**, and pressing a row opens the conversation. It does not draw the conversation. For the conversation view, use the separate plugin Better Paseo.

This version is Clear Chat 0.18.0.1, for Paseo 0.18.0. The minimum host stays Paseo 0.16.0. The browser checks ran on Paseo 0.18.0 and Paseo 0.17.5. The Paseo 0.18.0 desktop app was also checked on an isolated instance.

The interface text follows the app language: English, Simplified Chinese, or Japanese. The plugin list shows the English description.

## What it does

- Recognises numbered questions with at least two lettered options, plus a recommendation mark or a short-reply hint. A line of its own that names one option, such as `Recommended: A`, also marks that option. Code fences and quotations are ignored.
- The card's controls choose an option, write **Other**, preview a message such as `1B 2A`, and send it. After sending, the card is no longer shown; the message in the chat, such as `1B 2A`, is your answer.
- **Not options** dismisses a false detection and remembers it.
- Saved replies are edited on the settings page. On the card they insert a phrase and do not send.
- A bare letter inside a sentence is not treated as an answer. A numbered token such as `1A` still counts.

After a reply that asks lettered questions has finished, a button above the message box opens the card. It shows the progress, for example **Answer 0/2**; a desktop tooltip and a narrow screen's panel title carry the full name, for example **Answer card · 0/2 answered**. It opens the whole card in a panel, which is a sheet on a narrow screen. In the desktop panel the question area scrolls inside the card, and the progress line and **Send** stay in one row at the bottom, so **Send** is visible without scrolling the panel. Choosing answers updates the count, closing and reopening the panel keeps them, and the button is gone after **Send** until the next such reply finishes. The button belongs to the conversation on screen.

The settings page can be opened.

**The What I said screen** opens from a row in the sidebar header and takes the full width. It is a calendar of the days you typed across this host's conversations, opened on today: days with messages use four steps of the host's accent taken from the whole history, with a **Less** / **More** legend, and a bubble on a cell reads like `Nov 25 Wed · 41 messages`. The month title opens a year of twelve months, four across on a wide screen and two across on a narrow one, each with a short name and its total and no year; a month that cannot be opened is dimmed. Arrow keys move the highlight, Enter selects that day, and **T** selects today. On a screen that is already narrow the calendar is the week of the selected day, and **▾** expands the month. The selected day lists the messages you typed that day: each row shows the conversation title, the local time and up to three lines, pressing a row opens the conversation the message was sent in, **Copy** copies the message, and **Quote** keeps that conversation's draft and adds the quote after the whole draft, with one blank line between them. A host that cannot answer the history calls keeps the previous today-only page. This version reads Hermes directly; another provider's conversation is filled in from its timeline when you open that day, and until then that day's cell and the month and year totals can leave it out.

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

- **What I said** is a calendar of local days, not only today. A host that cannot answer the history calls keeps the today-only page. Paseo 0.18.0 and 0.17.5 answered the calls, so that fallback was not seen on a real host. Paseo 0.16.x was not checked.
- Conversations another agent started are not listed, and nothing typed into them directly is listed either. Conversations whose provider is unavailable are not listed by the host.
- Some providers cannot give back the history of a conversation restored from storage. Such conversations are counted as unreadable instead of listed, are not cached, and are read again on **Refresh** and **Try again**.
- Reading a conversation that is not loaded makes the daemon load it from storage, which takes time and memory until the daemon's idle cleanup.
- A conversation the Hermes read did not return is on that same fill-in. The fill-in still walks the timeline. The older timing — about one second per conversation restored from storage with Codex right after a daemon restart, and about four seconds for a test agent, measured on Paseo 0.17.4 — belongs to that path and was not measured again here.
- A screen row opens the conversation, not the message: the plugin API has no scroll-to-message surface.
- An archived conversation has no input: **Quote** opens the conversation and copies the quote.
- **Quote** does not replace an existing draft.
- On a host without client navigation, a screen row press copies the message instead of opening the conversation.
- A machine message is recognised by its leading text, so a message that opens with one of those shapes for another reason is counted as machine and is not listed.
- A day has a page budget. A read that stops short says it is partial and offers **Try again**, and the counts are then a lower bound, at least the number of rows listed.
- Clear Chat does not draw the conversation. Use Better Paseo for that view.
- `Plan 2B` can still be read as an answer.
- In the desktop panel a long written answer previews in at most two lines: the whole answer index, then the start of the first written answer. The message that is sent keeps the full answer, and the narrow panel shows the full preview.
- A window shorter than about 117 px is not supported: the panel's footer no longer fits.
- While the agent is answering, a card you can still edit has no button, and an open panel says the reply is still running; the button and the answers come back when it ends. A read-only card that is still waiting for your answer keeps its button.
- For up to about half a second after the agent starts answering, the button can still be there; a panel opened in that moment can show the wait message.
- At phone width, Esc does not close the card; tap outside the panel to close it. **Not options** dismisses that reply for good, card and button alike.
- A draft read that fails after the saved preferences are ready, and before a new reply or a new message from you arrives, leaves the card out of reach until one of those arrives or you reload. The draft itself is not lost. A read that finds no draft, or a shape this version rejects, is final and not retried.
- A rollback to the previous release keeps the settings and returns that screen to today only. **Copy** and **Quote** stay, because that release already has them. It does not bring back the conversation-header button or the panel beside the conversation, and it does not read the archive this version writes.
- The browser checks ran in the interface of Paseo 0.18.0 and of Paseo 0.17.5 (the web UI the `paseo` command starts), in a headless browser, on an isolated data folder, at 1280×800 and 390×844. Both hosts showed the calendar: the four dark-theme steps, the year view, the week strip (day cells 44 px tall, header arrows 44×44, no sideways overflow), the step from December 2025 to January 2026, arrow keys then Enter, **T** for today, **Copy**, and opening a conversation from a row. Each number used the text colour that read more clearly on its cell, and every step was at least 4.5 to 1 (the lowest 4.66 to 1). **Quote** kept the draft and placed the quote after it, with one blank line, on both hosts. Empty days and months with no messages use a neutral fill at the quiet end of the scale. Simplified Chinese and Japanese labels were read on Paseo 0.17.5, and also on Paseo 0.18.0 in an earlier pass. The Paseo 0.18.0 desktop app was checked on an isolated instance: the settings page showed Clear Chat 0.18.0.1, the sidebar row opened the screen, and the month, a day, the keyboard, the year view, a row that opened the conversation, and **Quote** keeping the draft were checked. The console showed no plugin error. It was not checked on a physical iOS or Android device, on Paseo 0.16.x or 0.17.1–0.17.4, or with a history of several thousand days.
- Removing the plugin deletes its settings. Back them up first.

The repository README has the answer-card and **What I said** steps and troubleshooting.
