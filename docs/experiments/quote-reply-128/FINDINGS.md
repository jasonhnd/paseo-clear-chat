# Quote-reply capability experiment

**Verdict: capability available.** In the Paseo 0.14.0 web UI, a plugin command used `context.paseo.agents.ref(context.agent.id).send(text)` to send a new message to the currently displayed, idle agent. The call resolved, the message appeared as a user prompt in the conversation, and the model replied with the calculated result `391 MARIGOLD`. The answer requires both calculating 17 × 23 and following the instruction in the sent message, rather than simply echoing it.

## Experiment

- Host and bundled web app: Paseo 0.14.0; host client and plugin SDK packages: 0.14.0.
- Clear Chat source: commit `707934d9b7e16d6dca07dac25f1ac81bfa395098`, manifest version `0.14.0.2`, development plugin SDK `0.13.0`. Clear Chat was running, along with a separate temporary probe plugin; no Clear Chat feature code or host code was changed.
- Provider: Codex CLI 0.164.0, model `gpt-6.1-sol`, low reasoning effort. The daemon, provider session, and browser profile used a fresh isolated home and a synthetic conversation.
- Browser: Playwright-bundled Chromium `153.0.8010.12` (the installed 1.63 browser), controlled by `playwright-core` 1.64.1; viewport 1440 × 900, device scale factor 1. The screenshot is an original, unedited host capture.
- The agent was created using the CLI with `Reply with exactly READY.` and replied `READY`. From the open agent UI, the probe's agent-context command was selected in the command center. No host composer input was automated and no host DOM was injected into.
- The probe sent exactly: `Calculate 17 times 23. Reply with only the number, followed by the word MARIGOLD.` The conversation then showed that text under `YOU`, followed by `391 MARIGOLD` from the assistant. The initial and subsequent transcript was independently captured from the daemon.

Evidence: [screenshot](conversation.png), [host transcript](host-transcript.txt), [visible UI text](conversation.txt), [probe console output](browser-console.txt), and [exact probe client source](probe.client.tsx.txt). The console output records the agent ID, the properties actually seen by the command, and successful resolution of `send`.

## UI-accessible routes

The runtime inventory below was recorded inside the real host by the agent-context command. Descriptions of uninvoked alternatives come from the 0.14.0 client SDK declarations and implementation, not from a second send experiment.

| Route | What it does and experiment status |
| --- | --- |
| `context.paseo.agents.ref(agentId).send(text, options?)` | Sends to the existing agent; **invoked successfully**. Resolving indicates the daemon accepted the request, not by itself that the model received it. The model reply supplies that evidence here. |
| `context.paseo.agents.ref(agentId).run(text, options?)` | Sends to the existing agent and waits for the turn to finish or need attention. Present as a function; implementation calls the same daemon send operation and then waits. Not invoked. |
| `context.paseo.agents.create({ ..., prompt })` | Creates a **new** agent with an optional initial prompt; not a way to send to the existing current agent. Not invoked by the probe. A workspace handle also exposes `agents.create`. |
| `context.paseo.agents.ref(agentId).timeline.append(item)` | Appends a plugin timeline item; it is not the agent prompt operation and cannot establish model receipt. Not invoked. |
| `usePaseo()` | Hook for contributed plugin surfaces returning a `PaseoApi`, from which the same agent-handle methods are typed. The experiment instead used the command's directly supplied `context.paseo`. |
| `getPaseoClient(serverId)` | SDK accessor for a configured online host's `PaseoApi`, from which the same agent-handle methods are typed. Not invoked. |

`context.agent.id` supplies the current agent in an agent-context command; a timeline renderer receives `agentId` in its props. `send` and `run` accept options including `activeTurnBehavior`. The SDK says omission interrupts a turn that is already running; this experiment only tested an idle agent and does not establish behavior during a running turn or across providers.

## Negative observations and limits

- `handle.prompt` and `handle.sendMessage` were both `undefined` in the runtime inventory. They are not usable as methods on this UI-facing handle. The lower-level daemon client has send methods, but it is not the handle returned here.
- On a fresh daemon, installing and individually enabling plugins left them disabled because global `pluginsEnabled` defaulted to false. Setting it to true allowed both plugins to start. This was host configuration, not a failure of `send`.
- Only `send` was invoked. The presence and implementation of `run` do not independently prove its behavior in the UI, and no claim is made for sending while an agent is running, other providers, mobile, or desktop.
