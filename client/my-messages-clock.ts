/**
 * The clock and retry timers for the "What I said" screen.
 *
 * The screen's "today" is the reader's local calendar day. Tests can replace the clock and
 * timers to exercise day changes and retries without waiting for them in real time.
 */

export interface FeedTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: FeedTimers = {
  set(callback, ms) {
    const timer = setTimeout(callback, ms);
    // A pending retry must not keep a test process, or a quitting app, alive.
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
