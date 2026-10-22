const capturedReplies = require("../fixtures/real-assistant-links.json");

const mailTarget = "mailto:hello@example.org?subject=Reply%20links&body=One%20tap%20%26%20done";

// The captures stay unchanged; mail links are a separate synthetic reply.
const replyLinkCases = [
  {
    item: capturedReplies[0],
    targets: ["https://example.com/guide", "https://example.com/sample/project"],
  },
  {
    item: capturedReplies[1],
    targets: ["https://example.com/diagram.png?mode=sample", "https://example.com/preview.png", "https://example.com/sample/project"],
  },
  {
    item: {
      type: "assistant_message",
      messageId: "sample-mail-reply",
      text: `[**Email support**](${mailTarget})\n\nEmail\uff1a${mailTarget}\u3002\n\nwww.example.org/guide and http://example.org/reference.`,
    },
    targets: [mailTarget, mailTarget, "https://www.example.org/guide", "http://example.org/reference"],
  },
];

module.exports = { replyLinkCases };
