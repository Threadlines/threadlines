// @effect-diagnostics globalTimers:off
export interface AssistantPresenceOptions {
  readonly holdMs: number;
  readonly recentMs: number;
  /** Requests waiting at once; past this, the next is answered at once. */
  readonly maxWaiting: number;
}

const DEFAULT_PRESENCE: AssistantPresenceOptions = {
  holdMs: 5_000,
  recentMs: 120_000,
  maxWaiting: 32,
};

/**
 * Whether an assistant's request should wait for the computer before the
 * door answers that it's offline. A computer's relay sockets drop and come
 * back now and then (a network blip, a socket replaced); a request landing in
 * that second would otherwise be told the computer is offline, and the
 * assistant would wait a minute before trying again.
 *
 * So a request with no live assistant socket waits up to `holdMs` for one,
 * when the computer is likely coming back: its control socket is still open
 * and leased, or one of its sockets closed within `recentMs` while it was. A computer gone longer than that (asleep,
 * Threadlines closed) is answered at once. In memory only: an object that
 * hibernated or restarted holds nothing, and answers as before.
 */
export class AssistantPresence {
  private goneAt: number | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly options: AssistantPresenceOptions;

  constructor(options: AssistantPresenceOptions = DEFAULT_PRESENCE) {
    this.options = options;
  }

  /** One of the computer's control or assistant sockets closed while it was there. */
  socketGone(now: number): void {
    this.goneAt = now;
  }

  /** A socket opened or a lease came in: waiting requests look again. */
  changed(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /** Whether a request with no live socket should wait: the computer was just there. */
  mayComeBack(now: number, controlOpen: boolean): boolean {
    if (this.waiters.size >= this.options.maxWaiting) return false;
    return controlOpen || (this.goneAt !== null && now - this.goneAt <= this.options.recentMs);
  }

  /** Waits up to `holdMs` for `find` to give a socket, looking again at each change. */
  wait<T>(find: () => T | null): Promise<T | null> {
    return new Promise((resolve) => {
      const finish = (found: T | null) => {
        clearTimeout(timer);
        this.waiters.delete(look);
        resolve(found);
      };
      const look = () => {
        const found = find();
        if (found !== null) finish(found);
      };
      const timer = setTimeout(() => finish(find()), this.options.holdMs);
      this.waiters.add(look);
    });
  }
}
