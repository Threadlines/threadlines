/**
 * Large values repeated across a thread's activity payloads, sent once.
 *
 * A tool call's screenshot or output rides on its in-progress `tool.updated`
 * rows and again on its `tool.completed` row, byte for byte, so a chat's
 * activities carry most of their bytes twice. The server sends each large
 * string once: later copies become a reference to the first one's place,
 * `{ [ACTIVITY_PAYLOAD_REF_KEY]: [activityId, ...path] }`. The client puts the
 * value back before anything reads the activities, so what it works with is
 * exactly what was stored; no rule about which copy a client shows is needed.
 *
 * Only for clients that ask (`acceptsPayloadRefs` on the request), and the
 * response says when it holds references (`sharedPayloadValues`), so stored
 * data that merely looks like one is never rewritten. An older client gets
 * the activities whole. Both directions live here so they cannot drift apart.
 *
 * @module activityPayloadRefs
 */

/** The key of a reference object. A payload already using it is sent whole. */
export const ACTIVITY_PAYLOAD_REF_KEY = "$threadlinesPayloadRef";

/** Strings shorter than this are sent as they are; a reference costs ~80 bytes. */
export const MIN_SHARED_VALUE_LENGTH = 1024;

/**
 * How deep into a payload either side looks. Anything nested deeper is sent
 * as it is, so a pathologically deep payload cannot overflow the stack.
 */
export const MAX_SHARED_VALUE_DEPTH = 200;

type PathSegment = string | number;
/** The activity id, then the keys and indexes leading to the value. */
type PayloadRef = readonly [string, ...PathSegment[]];

interface ActivityLike {
  readonly id: string;
  readonly payload: unknown;
}

/** Sets an own property, so a key such as `__proto__` stays a plain key. */
const setOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refOf = (value: unknown): PayloadRef | null => {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== ACTIVITY_PAYLOAD_REF_KEY) return null;
  const ref = value[ACTIVITY_PAYLOAD_REF_KEY];
  return Array.isArray(ref) && typeof ref[0] === "string" ? (ref as unknown as PayloadRef) : null;
};

interface FirstOccurrence {
  readonly ref: PayloadRef;
  /** Decided on the first repeat: a path longer than the value is not worth it. */
  smaller?: boolean;
}

/**
 * Replaces each repeated large string in the activities' payloads with a
 * reference to its first occurrence (in activity order, then depth-first),
 * when the reference is the smaller of the two. Returns the input unchanged
 * when nothing is replaced, or when any payload already holds an object with
 * ACTIVITY_PAYLOAD_REF_KEY where the client would look for one.
 */
export function shareRepeatedPayloadValues<A extends ActivityLike>(
  activities: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const firstSeen = new Map<string, FirstOccurrence>();
  const path: PathSegment[] = [];
  let changed = false;
  let collided = false;

  const share = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      if (value.length < MIN_SHARED_VALUE_LENGTH) return value;
      const seen = firstSeen.get(value);
      if (seen === undefined) {
        firstSeen.set(value, { ref: path.slice() as unknown as PayloadRef });
        return value;
      }
      const marker = { [ACTIVITY_PAYLOAD_REF_KEY]: seen.ref };
      seen.smaller ??= JSON.stringify(marker).length < value.length;
      if (!seen.smaller) return value;
      changed = true;
      return marker;
    }
    // Checked before the depth limit: restoring looks for a reference at the
    // limit too.
    if (isPlainObject(value) && Object.hasOwn(value, ACTIVITY_PAYLOAD_REF_KEY)) {
      collided = true;
      return value;
    }
    if (depth >= MAX_SHARED_VALUE_DEPTH) return value;
    if (Array.isArray(value)) {
      let copy: unknown[] | null = null;
      for (let index = 0; index < value.length; index += 1) {
        path.push(index);
        const next = share(value[index], depth + 1);
        path.pop();
        if (next !== value[index]) {
          copy ??= value.slice();
          copy[index] = next;
        }
      }
      return copy ?? value;
    }
    if (isPlainObject(value)) {
      let copy: Record<string, unknown> | null = null;
      for (const key of Object.keys(value)) {
        path.push(key);
        const next = share(value[key], depth + 1);
        path.pop();
        if (next !== value[key]) {
          copy ??= { ...value };
          setOwn(copy, key, next);
        }
      }
      return copy ?? value;
    }
    return value;
  };

  const shared = activities.map((activity) => {
    path.length = 0;
    path.push(activity.id);
    const payload = share(activity.payload, 0);
    return payload === activity.payload ? activity : { ...activity, payload };
  });
  return changed && !collided ? shared : activities;
}

/**
 * Puts back every value shareRepeatedPayloadValues replaced, so each payload
 * equals the stored one. Call it only on a response marked
 * `sharedPayloadValues`. A reference points into an activity in the same
 * list; one that resolves to nothing is left as it is.
 */
export function restoreSharedPayloadValues<A extends ActivityLike>(
  activities: ReadonlyArray<A>,
): ReadonlyArray<A> {
  // References name a first occurrence, which is never itself a reference,
  // so resolving against the payloads as received is enough.
  const payloadById = new Map<string, unknown>();
  for (const activity of activities) payloadById.set(activity.id, activity.payload);

  const resolve = (ref: PayloadRef): unknown => {
    let value = payloadById.get(ref[0]);
    for (let index = 1; index < ref.length; index += 1) {
      const segment = ref[index]!;
      if (Array.isArray(value) && typeof segment === "number") value = value[segment];
      else if (isPlainObject(value) && typeof segment === "string") value = value[segment];
      else return undefined;
    }
    return typeof value === "string" ? value : undefined;
  };

  const restore = (value: unknown, depth: number): unknown => {
    const ref = refOf(value);
    if (ref !== null) return resolve(ref) ?? value;
    if (depth >= MAX_SHARED_VALUE_DEPTH) return value;
    if (Array.isArray(value)) {
      let copy: unknown[] | null = null;
      for (let index = 0; index < value.length; index += 1) {
        const next = restore(value[index], depth + 1);
        if (next !== value[index]) {
          copy ??= value.slice();
          copy[index] = next;
        }
      }
      return copy ?? value;
    }
    if (isPlainObject(value)) {
      let copy: Record<string, unknown> | null = null;
      for (const key of Object.keys(value)) {
        const next = restore(value[key], depth + 1);
        if (next !== value[key]) {
          copy ??= { ...value };
          setOwn(copy, key, next);
        }
      }
      return copy ?? value;
    }
    return value;
  };

  let changed = false;
  const restored = activities.map((activity) => {
    const payload = restore(activity.payload, 0);
    if (payload === activity.payload) return activity;
    changed = true;
    return { ...activity, payload };
  });
  return changed ? restored : activities;
}
