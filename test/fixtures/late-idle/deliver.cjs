"use strict";

const frames = require("./frames.json");

// deliver resolves only after the consumer has processed the frame. The
// observation callback is an explicit gate before the delayed frame is sent.
async function deliverLateIdle({ deliver, observeRunning }) {
  await deliver(structuredClone(frames.running));
  await observeRunning();
  await deliver(structuredClone(frames.olderIdle));
}

module.exports = { deliverLateIdle };
