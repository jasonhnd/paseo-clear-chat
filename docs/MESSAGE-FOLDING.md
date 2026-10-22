# Message folding

**Fold long output after** controls tool output, fenced code in assistant replies, and text in
enhanced prompt bubbles. The existing choices remain 10, 15 (default), 30 source lines or Never.
No preference fields or settings versions change. A block at the threshold stays whole. Line
counting accepts LF and CRLF and ignores one final newline, matching tool output. Soft wrapping
does not add source lines.

Long content previews the selected number of lines. **Show all N lines** opens it and **Show fewer
lines** closes it. The controls have a minimum height of 44 pixels. Reply prose before and after
code stays visible. Prompt attachments and usage stay outside the text disclosure. Copy always
uses the complete prompt, code or reply, including content outside the preview.

Explicit message choices are stored through the existing revision-checked host expansion service.
Host, agent, message ID (when available), timeline timestamp and block/section identify each choice.
Different code blocks and wrap-up sections keep separate choices. Only identities, timestamps and
booleans enter storage; message content does not. The store retains its existing 1,000-choice limit,
merge/retry behavior, debounce and flush on unmount. Explicit choices survive preference changes;
Never always shows complete content. A storage failure leaves the text usable and shows a retry
message. Toggling again retries the save.

The same components render at all viewport widths and on web, iOS/iPadOS and Android. Turning
off **Assistant markdown** or **Enhanced prompt bubble** returns the corresponding item to Paseo.
Prompts without attachment metadata also remain with Paseo so hidden attachments are preserved.
These host-rendered prompts are outside the plugin's folding controls.

## Verification

Run the registered transformer/component regressions with:

```sh
node --test test/message-folding.test.cjs
```

The tests derive long content from the existing sanitized reply-footer and wrap-up fixture shapes;
all added text is synthetic. They cover web, iOS and Android, every limit, threshold equality,
CRLF, full-source copying, expansion/collapse after a fresh module read, independent identities,
wrap-up sections, prompt attachments and storage failure recovery. Existing reply-prose and tool
folding regressions remain in the full suite.

For actual browser layout, install the isolated showcase dependencies and run:

```sh
npm ci --prefix .showcase --include=dev
KANBAN_TMP="$TMPDIR" node .showcase/replay-message-folding.cjs
```

`TMPDIR` must already point to the task's authorized temporary directory. The runner bundles real
components, uses a synthetic revision-checked storage service and captures copies through the SDK
shim. It launches only installed Google Chrome in headless mode, chooses an available debugging
port from 9444 through 9499, serves on an ephemeral loopback port and blocks external requests.
It never connects to a live Paseo instance.

At widths 1440, 1024, 820 and 390, it measures both collapsed and expanded heights, checks the
44-pixel controls, full-source copying, hard-reload restoration, all limit choices and absence of
horizontal page overflow. A JSON report and screenshots stay in the task's temporary directory;
the Chrome profile is removed after the run. This is component verification. Final review and
iPhone, iPad and Android device checks remain with the reviewer and user.
