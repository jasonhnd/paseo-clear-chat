// Fields supplied from isolated MI/ZK/PP native session/new captures.
// Minimal extracted model catalog subset; protocol evidence, not provider acceptance.
module.exports = {
  "labels": [
    "MI",
    "ZK",
    "PP"
  ],
  "configOptions": null,
  "models": {
    "currentModelId": "claude-subscription-directsdk-experimental:claude-opus-5-5[1m]",
    "availableModels": [
      {
        "modelId": "claude-subscription-directsdk-experimental:claude-opus-5-5[1m]",
        "name": "claude-subscription-directsdk-experimental · claude-opus-5-5[1m]",
        "description": "Provider: claude-subscription-directsdk-experimental • current"
      },
      {
        "modelId": "anthropic:claude-opus-5-5",
        "name": "Anthropic · claude-opus-5-5",
        "description": "Provider: Anthropic"
      }
    ]
  },
  "modes": {
    "availableModes": [
      {
        "description": "Ask before edits.",
        "id": "default",
        "name": "Default"
      },
      {
        "description": "Auto-allow workspace and temp-dir edits; still asks for sensitive paths.",
        "id": "accept_edits",
        "name": "Accept Edits"
      },
      {
        "description": "Auto-allow file edits for this session except sensitive paths.",
        "id": "dont_ask",
        "name": "Don't Ask"
      }
    ],
    "currentModeId": "default"
  }
};
