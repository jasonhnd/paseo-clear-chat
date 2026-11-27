Clear Chat is a Paseo plugin for the answer card and **What I said**. When a reply asks lettered questions, the card lets you pick an option or write your own, preview the answer, and send it. **What I said** is a full screen, opened from a row in the sidebar header, that gathers today's messages from this host's conversations. Every row has **Copy** and **Quote**, and pressing a row opens the conversation the message was sent in. It does not draw the conversation. For the conversation view, use the separate plugin Better Paseo.

This version is Clear Chat 0.17.5.2, for Paseo 0.17.5. The minimum host stays Paseo 0.16.0.

The interface text follows the app language: English, Simplified Chinese, or Japanese. The plugin list shows the English description.

## What it does

- Recognises numbered questions with at least two lettered options, plus a recommendation mark or a short-reply hint. A line of its own that names one option, such as `Recommended: A`, also marks that option. Code fences and quotations are ignored.
- The card's controls choose an option, write **Other**, preview a message such as `1B 2A`, and send it. After sending, the card is no longer shown; the message in the chat, such as `1B 2A`, is your answer.
- **Not options** dismisses a false detection and remembers it.
- Saved replies are edited on the settings page. On the card they insert a phrase and do not send.
- A bare letter inside a sentence is not treated as an answer. A numbered token such as `1A` still counts.

After a reply that asks lettered questions has finished, a button above the message box opens the card. It shows the progress, for example **Answer 0/2**; a desktop tooltip and a narrow screen's panel title carry the full name, for example **Answer card · 0/2 answered**. It opens the whole card in a panel, which is a sheet on a narrow screen. In the desktop panel the question area scrolls inside the card, and the progress line and **Send** stay in one row at the bottom, so **Send** is visible without scrolling the panel. Choosing answers updates the count, closing and reopening the panel keeps them, and the button is gone after **Send** until the next such reply finishes. The button belongs to the conversation on screen.

The settings page can be opened.

**The What I said screen** opens from a row in the sidebar header and takes the full width. It lists the messages you typed today across this host's conversations, conversations archived today included: a summary line such as `From you today: 12 · Conversations: 3`, a progress line such as `Reading 3 of 7…`, **Refresh**, and rows with the conversation title, the local time and up to three lines of the body. Pressing a row opens the conversation the message was sent in, on the same host; on a host without client navigation it copies the message. Each row also has **Copy**, which copies the message, and **Quote**, which inserts it into that row's conversation as a Markdown quote at the cursor; a conversation with no input is opened and the quote is copied, with a toast. A list that was only partly read says it may be incomplete and offers **Try again**; **Refresh** and **Try again** list the conversations again and refill an empty list, and **Try again** gives a conversation that was only partly read or failed a larger page budget; conversations whose history the host could not give back are counted in a line of their own. A screen left open past local midnight says its rows are an earlier day's the next time it is scrolled or pressed, until **Refresh**. Rows appear as each conversation is read. Conversations another agent started are not listed, and neither is anything typed into them directly. At phone width the row is in the sidebar drawer.

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
- A screen row opens the conversation, not the message: the plugin API has no scroll-to-message surface.
- An archived conversation has no input: **Quote** opens the conversation and copies the quote.
- **Quote** inserts at the cursor and does not replace an existing draft.
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
- This version removes the **What I said** button from the conversation header and the panel beside the conversation. A rollback to the previous release keeps the settings and brings them back; the screen's rows return to copy-only, because that release has no **Copy** or **Quote** buttons. A rollback to an earlier release keeps the saved choices but not the continued state: a card you continued asks for **Continue answering** again after a reload.
- The browser checks for this release ran in the interface of Paseo 0.17.5, in a headless browser, at 1280×800 and 390×844, with a synthetic provider and a real provider (Codex), on commits f9f0da30 and 56087f61. For the screen: a row press opened the conversation, including an archived conversation and one on a second connected host; **Copy** copied the message without opening the row; **Quote** inserted into the conversation of that row and left another conversation's draft untouched; an archived row's **Quote** opened the conversation and copied the quote; at 390 wide the buttons were 44 px tall and stayed in the viewport; the Simplified Chinese labels and toasts were right; a row with no text (a whitespace-only message, shown as `(image)`) answered **Quote** with a no-text toast; and the console showed no plugin errors. The panel was checked at those commits before it was removed, and it is not part of this release. After the second checked commit, the quote is built line by line and **Quote** has its own empty-message toast; unit tests cover both. Then `80a0dba` removed the header button and the panel, and `9618fe4` narrowed the quote action's types without changing its behaviour. The browser checks were repeated after the panel was removed (commit `80a0dbaa`): no header button or panel, a row press opened a conversation and an archived conversation, **Quote** and **Copy** behaved as above, the buttons at 390 wide were inside the viewport, the settings page showed 0.17.5.2, and the console showed no plugin errors. It was not checked in the desktop app, on physical iOS or Android devices, on Paseo 0.16.x, 0.17.1, 0.17.2, 0.17.3 or 0.17.4, in the dark theme, in the Japanese interface, or at other viewport sizes.
- Removing the plugin deletes its settings. Back them up first.

The repository README has the answer-card and **What I said** steps and troubleshooting.
