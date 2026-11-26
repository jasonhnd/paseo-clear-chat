/**
 * The clock and the timers the panel reads, in one place.
 *
 * The panel's "today" is the reader's local calendar day, so it has to notice midnight while
 * it sits open. Reading `Date.now()` and `setTimeout` directly would make that untestable
 * without waiting a day, so both go through here: production uses the real clock, and a test
 * replaces them for the length of one case.
 */

export interface FeedTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: FeedTimers = {
  set(callback, ms) {
    const timer = setTimeout(callback, ms);
    // A pending midnight timer must not keep a test process, or a quitting app, alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

let clock: () => number = () => Date.now();
let timers: FeedTimers = realTimers;

/** Milliseconds since the epoch, on whatever clock this process is using. */
export function nowMs(): number {
  return clock();
}

export function scheduleTimer(callback: () => void, ms: number): unknown {
  return timers.set(callback, ms);
}

export function cancelTimer(handle: unknown): void {
  timers.clear(handle);
}

export function currentTimers(): FeedTimers {
  return timers;
}

/** Replaces the clock. `null` restores `Date.now`. */
export function setMyMessagesClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

/** Replaces the timer table. `null` restores the real one. */
export function setMyMessagesTimers(next: FeedTimers | null): void {
  timers = next ?? realTimers;
}
