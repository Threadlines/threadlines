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
 * Only for clients that ask (`acceptsPayloadRefs` on the request): an older
 * client gets the activities whole. Both directions live here so they cannot
 * drift apart.
 *
 * @module activityPayloadRefs
 */

/** The key of a reference object. A payload already using it is sent whole. */
export const ACTIVITY_PAYLOAD_REF_KEY = "$threadlinesPayloadRef";

/** Strings shorter than this are sent as they are; a reference costs ~80 bytes. */
export const MIN_SHARED_VALUE_LENGTH = 1024;

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

/**
 * Replaces each repeated large string in the activities' payloads with a
 * reference to its first occurrence (in activity order, then depth-first).
 * Returns the input unchanged when nothing repeats, or when any payload
 * already holds an object with ACTIVITY_PAYLOAD_REF_KEY.
 */
export function shareRepeatedPayloadValues<A extends ActivityLike>(
  activities: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const firstSeen = new Map<string, PayloadRef>();
  const path: PathSegment[] = [];
  let changed = false;
  let collided = false;

  const share = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.length < MIN_SHARED_VALUE_LENGTH) return value;
      const ref = firstSeen.get(value);
      if (ref !== undefined) {
        changed = true;
        return { [ACTIVITY_PAYLOAD_REF_KEY]: ref };
      }
      firstSeen.set(value, path.slice() as unknown as PayloadRef);
      return value;
    }
    if (Array.isArray(value)) {
      let copy: unknown[] | null = null;
      for (let index = 0; index < value.length; index += 1) {
        path.push(index);
        const next = share(value[index]);
        path.pop();
        if (next !== value[index]) {
          copy ??= value.slice();
          copy[index] = next;
        }
      }
      return copy ?? value;
    }
    if (isPlainObject(value)) {
      if (Object.hasOwn(value, ACTIVITY_PAYLOAD_REF_KEY)) {
        collided = true;
        return value;
      }
      let copy: Record<string, unknown> | null = null;
      for (const key of Object.keys(value)) {
        path.push(key);
        const next = share(value[key]);
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
    const payload = share(activity.payload);
    return payload === activity.payload ? activity : { ...activity, payload };
  });
  return changed && !collided ? shared : activities;
}

/**
 * Puts back every value shareRepeatedPayloadValues replaced, so each payload
 * equals the stored one. A reference points into an activity in the same
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

  const restore = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      let copy: unknown[] | null = null;
      for (let index = 0; index < value.length; index += 1) {
        const next = restore(value[index]);
        if (next !== value[index]) {
          copy ??= value.slice();
          copy[index] = next;
        }
      }
      return copy ?? value;
    }
    if (isPlainObject(value)) {
      const ref = refOf(value);
      if (ref !== null) return resolve(ref) ?? value;
      let copy: Record<string, unknown> | null = null;
      for (const key of Object.keys(value)) {
        const next = restore(value[key]);
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
    const payload = restore(activity.payload);
    if (payload === activity.payload) return activity;
    changed = true;
    return { ...activity, payload };
  });
  return changed ? restored : activities;
}
