/**
 * Remembered derivations for the work a chat repeats each time it is opened.
 * A component's own memo keeps only its latest result, so switching back to a
 * chat would derive everything again. Two shapes:
 *
 * - `keyedMemo`: one result per immutable object (a tool payload, a message),
 *   for scans that depend on nothing else. Kept as long as the object lives.
 * - `threadMemo` / `threadMemoOfInput`: one result per chat, for the most
 *   recently used chats, reused only when every input is the same value.
 *
 * Every `derive` must be pure: the same inputs must give the same result.
 */

/**
 * One result per immutable `key` object (a store value: new data is a new
 * object), with any other inputs compared like a hook's deps; when one
 * differs, the result is derived again and replaces the remembered one.
 */
export function keyedMemo<K extends object, D extends readonly unknown[], R>(
  derive: (key: K, ...deps: D) => R,
): (key: K, ...deps: D) => R {
  const results = new WeakMap<K, { readonly deps: D; readonly value: R }>();
  return (key, ...deps) => {
    const remembered = results.get(key);
    if (remembered !== undefined && sameInputs(remembered.deps, deps)) {
      return remembered.value;
    }
    const value = derive(key, ...deps);
    results.set(key, { deps, value });
    return value;
  };
}

/** How many chats keep their derivations: the recent ones a user switches between. */
export const REMEMBERED_THREAD_LIMIT = 8;

/**
 * A chat's derivation, remembered per thread (`threadKey`, the scoped thread
 * key) for the `REMEMBERED_THREAD_LIMIT` most recently used threads. The
 * result is reused only when every input is the same value as when it was
 * derived, compared with `Object.is`: the store's arrays by identity, so new
 * data always derives again, and a chat-local input (an optimistic message,
 * a steering hand-off) reaches the cache only through the inputs it changes.
 */
export function threadMemo<A extends readonly unknown[], R>(
  derive: (...inputs: A) => R,
): (threadKey: string, ...inputs: A) => R {
  const results = new RecentThreads<{ readonly inputs: A; readonly value: R }>();
  return (threadKey, ...inputs) => {
    const remembered = results.get(threadKey);
    if (remembered !== undefined && sameInputs(remembered.inputs, inputs)) {
      return remembered.value;
    }
    const value = derive(...inputs);
    results.set(threadKey, { inputs, value });
    return value;
  };
}

type FieldComparisons<I> = {
  readonly [F in keyof I]?: (left: I[F], right: I[F]) => boolean;
};

/**
 * `threadMemo` for a derivation that takes one input object, compared field
 * by field, so a caller can build the input afresh from the same values.
 * `sameField` replaces `Object.is` for a field the derivation reads only by
 * content (a map it looks names up in), which may be rebuilt with equal
 * contents.
 */
export function threadMemoOfInput<I extends object, R>(
  derive: (input: I) => R,
  sameField: FieldComparisons<I> = {},
): (threadKey: string, input: I) => R {
  const results = new RecentThreads<{ readonly input: I; readonly value: R }>();
  return (threadKey, input) => {
    const remembered = results.get(threadKey);
    if (remembered !== undefined && sameFields(remembered.input, input, sameField)) {
      return remembered.value;
    }
    const value = derive(input);
    results.set(threadKey, { input, value });
    return value;
  };
}

/** Values by thread key, dropping the least recently used past the limit. */
class RecentThreads<V> {
  private readonly values = new Map<string, V>();

  get(threadKey: string): V | undefined {
    const value = this.values.get(threadKey);
    if (value !== undefined) {
      this.values.delete(threadKey);
      this.values.set(threadKey, value);
    }
    return value;
  }

  set(threadKey: string, value: V): void {
    this.values.delete(threadKey);
    this.values.set(threadKey, value);
    if (this.values.size > REMEMBERED_THREAD_LIMIT) {
      const oldest = this.values.keys().next();
      if (!oldest.done) {
        this.values.delete(oldest.value);
      }
    }
  }
}

function sameFields<I extends object>(left: I, right: I, sameField: FieldComparisons<I>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right) as Array<keyof I & string>;
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of rightKeys) {
    if (!Object.hasOwn(left, key)) {
      return false;
    }
    const same = sameField[key] ?? Object.is;
    if (!same(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function sameInputs(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) {
      return false;
    }
  }
  return true;
}
