# Synthetic late-idle frames

`frames.json` contains complete synthetic `agent_update` messages. The scenario
is ordered by delivery: `running`, then `olderIdle`. Both refer to the same
agent and generation; the delayed idle frame has an earlier sequence and
update time. Deliver the second frame only after observing the running state.
A protected consumer is expected to retain the running card after that frame.

For a control, deliver `running`, then `newerIdle`: the latter has a later
sequence and update time and represents a legitimate transition to idle.
A consumer that blindly applies arrival order is a negative control: it will
incorrectly replace running with the delayed older idle state.

`deliver.cjs` exports `deliverLateIdle`, which takes `deliver` and
`observeRunning` callbacks. `deliver` must resolve after the consumer processes
the frame; `observeRunning` must observe the running card and resolves to release
the older idle frame. The caller can inspect the card after the replay resolves.
No timing or wall-clock delay is involved.

Run `node --test test/late-idle-fixture.test.cjs` to check the frames, gated
delivery, and card state against a small sequence-aware consumer model. The
fixture is offline and does not provide a host, transport, or UI injection
mechanism. The model is not Paseo's host implementation, so this test does not
establish that a real host keeps the card visible. A separate isolated host
handoff must connect these callbacks to the actual consumer and preserve the
delivered protocol frames and UI evidence for acceptance.
