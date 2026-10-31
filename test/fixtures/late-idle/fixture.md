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

Run `node --test test/late-idle-fixture.test.cjs` to check the frame schema and
ordering. The fixture is offline: it does not provide a host, transport, or UI
injection mechanism. These tests validate inputs only; they do not demonstrate
that a running card remains visible. A separate isolated host handoff must
preserve the delivered protocol frames and actual UI evidence for acceptance.
