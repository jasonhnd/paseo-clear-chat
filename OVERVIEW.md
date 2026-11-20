Clear Chat is a Paseo plugin for the answer card. When a reply asks lettered questions, the card lets you pick an option or write your own, preview the answer, and send it. It does not draw the conversation. For the conversation view, use the separate plugin Better Paseo.

The interface text follows the app language: English, Simplified Chinese, or Japanese. The plugin list shows the English description.

## What's new in 0.16.2.2

- Clear Chat no longer draws the conversation: no step rows, tool cards, sidebar, search, quote-and-reply, or syntax highlighting.
- The settings page is titled **Answer card**. It sets the answer card switch and saved replies, and shows the installed version and **Report a problem**.
- This version does not show the answer card.

## What it does

- Recognises numbered questions with at least two lettered options, plus a recommendation mark or a short-reply hint. Code fences and quotations are ignored.
- The card's controls choose an option, write **Other**, preview a message such as `1B 2A`, and send it. After sending, the card is grey and read-only.
- **Not options** dismisses a false detection and remembers it.
- Saved replies are edited on the settings page. On the card they insert a phrase and do not send.
- A bare letter inside a sentence is not treated as an answer. A numbered token such as `1A` still counts.

<!-- TODO(answer-card-location) -->

This version does not place the card on screen. The settings page is registered.

## Setup

Clear Chat 0.16.2.2 needs Paseo 0.16.0 or later. On Paseo 0.15.x this version cannot run normally; stay on Clear Chat 0.15.4.x. This build was not checked inside a running Paseo app.

Installation runs `npm ci` on the daemon host, so Node.js and npm must be available there and the host must be able to reach the npm registry.

```bash
paseo plugin install git:jasonhnd/paseo-clear-chat --ref v0.16.2.2
paseo plugin update clear-chat --ref v0.16.2.2 --yes
```

If you used Beautiful Chat, its settings file is copied on first start when Clear Chat has none yet. Read the upgrade steps in the repository README before removing Beautiful Chat, because removing a plugin also removes its settings. Copied keys for features this version no longer shows stay in the file and have no control.

## Settings

Open **Settings → Plugins → Clear Chat**. The page title is **Answer card**.

- **Show an answer card under replies that ask lettered questions** is on when no value is stored. A stored value still wins. This version does not show the card either way.
- **Saved replies** is one phrase per line. The default phrases are `Go with the recommended`, `Leave it for now`, and `Continue`.
- The installed version is shown under the title. A directory install can show an older version from that directory.
- **Report a problem** opens a GitHub issue form in the browser. Nothing is sent unless you submit it.

Settings are saved on the host and shared by every client connected to it.

## Data and permissions

- Clear Chat does not send conversation content off the host, except the message you send yourself. **Send** on the answer card sends one message, written as you, through Paseo to the agent of the current chat.
- This version does not read local image files, highlight code, or register a provider copy.
- Startup does not delete anything under the plugin data directory. Older image and history directories are left in place and are not used.
- The only network use by Clear Chat itself is `npm ci` at install time.
- **Report a problem** opens a GitHub issue form. Nothing is sent unless you submit it.

## Limitations

- This version does not show the answer card.
- Clear Chat does not draw the conversation. Use Better Paseo for that view.
- `Plan 2B` can still be read as an answer.
- This version was not checked inside a running Paseo app, with a real model, or on physical iOS or Android devices.
- Removing the plugin deletes its settings. Back them up first.

The repository README has the install commands, the answer-card steps, and troubleshooting.
