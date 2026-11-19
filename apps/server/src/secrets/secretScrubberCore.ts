/**
 * The matching behind hiding a printed key (docs/design/secret-scrubbing.md):
 * a registry of watched values, each with its forms, and the functions every
 * hook uses to replace them with `[NAME hidden]`. Synchronous and pure apart
 * from its own state, so the provider path pays no effect overhead and the
 * rules can be tested directly. Nothing here logs a value.
 */
import { randomUUID } from "node:crypto";

import { EventId, type ProviderRuntimeEvent, type ThreadId } from "@threadlines/contracts";
import { isWatchableSecret, secretPlaceholder } from "@threadlines/shared/secretRequests";
import { parseSessionKey } from "@threadlines/shared/threadParticipants";

/** A long value is found by its first characters, then hidden as far as the text agrees. */
const HEAD_LENGTH = 256;
/** The most values watched at once; past it the oldest with no live file goes first. */
export const MAX_WATCHED_SECRETS = 200;
/** A snapshot cut partway through a value loses a tail at least this long. */
const MIN_CUT_TAIL = 4;
/** What stands in for a key whose own name would spell out another watched key. */
const NEUTRAL_NAME = "a saved key";

interface Entry {
  readonly name: string;
  readonly value: string;
  readonly ordinal: number;
  readonly forms: ReadonlyArray<Form>;
  /** The requests whose file still holds it; none: it is kept only because a model may repeat it. */
  readonly requestIds: Set<string>;
  /** What replaces it, and the name a notice uses: never one that holds a watched value. */
  placeholder: string;
  shownName: string;
}

interface Form {
  readonly entry: Entry;
  readonly text: string;
  readonly head: string;
}

interface Match {
  readonly start: number;
  end: number;
  readonly entry: Entry;
  /** The match ran to the end of the text partway through a long value. */
  open: OpenMatch | undefined;
}

interface OpenMatch {
  readonly form: Form;
  readonly offset: number;
}

/**
 * What a buffer held back: the tail that could start a watched value, and a
 * long value still being matched across pieces. Never a whole value.
 */
export interface HeldText {
  readonly held: string;
  readonly open: OpenMatch | undefined;
  /** Text already sent that a value could continue from: kept after a release. */
  readonly sent?: string;
}

/** A piece after holding: what to send now, what the buffer holds next, the names it hid. */
export interface HoldResult {
  readonly out: string;
  readonly state: HeldText | undefined;
  readonly names: ReadonlyArray<string>;
}

/** A string with its watched values hidden, and the names it hid. */
export interface Scrubbed {
  readonly text: string;
  readonly names: ReadonlyArray<string>;
}

export interface ScrubDeepOptions {
  /**
   * Cut a string value (never a member name) that stops 4 or more characters
   * into a watched value: a snapshot of output still being written.
   */
  readonly cutTail?: boolean;
  /**
   * Hears each string a whole match rewrote, with its original, and returns
   * the string to use: questions keep two rewritten texts apart this way.
   */
  readonly changed?: (hidden: string, original: string) => string;
}

/** The forms a value can take in text: as saved, JSON-escaped, URL-encoded. */
function formsOf(value: string): ReadonlyArray<string> {
  const forms = new Set<string>([value]);
  forms.add(JSON.stringify(value).slice(1, -1));
  forms.add(encodeURIComponent(value));
  return [...forms];
}

export function makeSecretScrubberCore() {
  const entries: Entry[] = [];
  let forms: Form[] = [];
  /** First characters of every form's head: a cheap filter for held tails. */
  let firstCharacters = new Set<string>();
  let longestHead = 0;

  const holdsWatched = (text: string) => forms.some((form) => text.includes(form.text));

  const rebuild = () => {
    forms = entries.flatMap((entry) => entry.forms);
    firstCharacters = new Set(forms.map((form) => form.head[0] ?? ""));
    longestHead = Math.max(0, ...forms.map((form) => form.head.length));
    // A placeholder or notice must never spell out another watched key, as a
    // name chosen equal to one would.
    for (const entry of entries) {
      const placeholder = secretPlaceholder(entry.name, entry.ordinal);
      const safe = !holdsWatched(placeholder);
      entry.placeholder = safe ? placeholder : secretPlaceholder(NEUTRAL_NAME, entry.ordinal);
      entry.shownName = safe ? entry.name : NEUTRAL_NAME;
    }
  };

  /**
   * Starts watching a value saved under `name`, for `requestId` while its
   * file holds it. A value that can't be hidden safely is not watched
   * (isWatchableSecret). Returns whether it is.
   */
  const watch = (name: string, value: string, requestId?: string): boolean => {
    if (!isWatchableSecret(name, value) || secretPlaceholder(NEUTRAL_NAME).includes(value)) {
      return false;
    }
    const existing = entries.find((entry) => entry.value === value && entry.name === name);
    if (existing !== undefined) {
      if (requestId !== undefined) existing.requestIds.add(requestId);
      return true;
    }
    const ordinal = entries.filter((entry) => entry.name === name).length + 1;
    const entry: Entry = {
      name,
      value,
      ordinal,
      forms: [],
      requestIds: new Set(requestId === undefined ? [] : [requestId]),
      placeholder: "",
      shownName: name,
    };
    (entry as { forms: ReadonlyArray<Form> }).forms = formsOf(value).map((text) => ({
      entry,
      text,
      head: text.slice(0, HEAD_LENGTH),
    }));
    entries.push(entry);
    if (entries.length > MAX_WATCHED_SECRETS) {
      const gone = entries.findIndex((candidate) => candidate.requestIds.size === 0);
      entries.splice(gone === -1 ? 0 : gone, 1);
    }
    rebuild();
    return true;
  };

  /** A request's file is gone: its value is still watched, but goes first past the limit. */
  const gone = (requestId: string) => {
    for (const entry of entries) entry.requestIds.delete(requestId);
  };

  /** Every place a watched form starts in `text`, non-overlapping, earliest first. */
  const findMatches = (text: string): Match[] => {
    const found: Match[] = [];
    for (const form of forms) {
      let from = 0;
      while (from <= text.length - form.head.length) {
        const at = text.indexOf(form.head, from);
        if (at === -1) break;
        let end = at + form.head.length;
        while (
          end < text.length &&
          end - at < form.text.length &&
          text[end] === form.text[end - at]
        ) {
          end += 1;
        }
        const open =
          end === text.length && end - at < form.text.length
            ? { form, offset: end - at }
            : undefined;
        found.push({ start: at, end, entry: form.entry, open });
        from = end;
      }
    }
    if (found.length <= 1) return found;
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const chosen: Match[] = [];
    for (const match of found) {
      const last = chosen.at(-1);
      if (last === undefined || match.start >= last.end) {
        chosen.push({ ...match });
      } else if (match.end > last.end) {
        last.end = match.end;
        last.open = match.open;
      }
    }
    return chosen;
  };

  const replaceMatches = (text: string, matches: ReadonlyArray<Match>, upTo = text.length) => {
    let out = "";
    let at = 0;
    for (const match of matches) {
      out += text.slice(at, match.start) + match.entry.placeholder;
      at = match.end;
    }
    return out + text.slice(at, upTo);
  };

  /**
   * The length of the longest tail of `text` that is the start of a watched
   * form's head (and shorter than the head), at least `minimum` long.
   */
  const startingTail = (text: string, minimum: number): number => {
    const limit = Math.min(text.length, longestHead - 1);
    for (let length = limit; length >= minimum; length -= 1) {
      const tail = text.slice(text.length - length);
      if (!firstCharacters.has(tail[0] ?? "")) continue;
      if (forms.some((form) => form.head.length > length && form.head.startsWith(tail))) {
        return length;
      }
    }
    return 0;
  };

  const namesOf = (matches: ReadonlyArray<Match>) => [
    ...new Set(matches.map((match) => match.entry.shownName)),
  ];

  /**
   * Hides watched values in a string. With `cutTail`, a string that stops
   * 4 or more characters into a value (a snapshot of output still being
   * written) loses that tail; the next snapshot holds the whole value.
   */
  const scrubText = (text: string, options?: { readonly cutTail?: boolean }): Scrubbed => {
    if (forms.length === 0 || text.length === 0) return { text, names: [] };
    const matches = findMatches(text);
    const lastEnd = matches.at(-1)?.end ?? 0;
    const cut =
      options?.cutTail === true && matches.at(-1)?.open === undefined
        ? startingTail(text.slice(lastEnd), MIN_CUT_TAIL)
        : 0;
    if (matches.length === 0 && cut === 0) return { text, names: [] };
    return { text: replaceMatches(text, matches, text.length - cut), names: namesOf(matches) };
  };

  /**
   * Hides watched values in every string and member name of a JSON-like
   * value. The same object comes back when nothing matched.
   */
  const scrubDeep = (
    value: unknown,
    names: Set<string>,
    options?: ScrubDeepOptions,
    isKey = false,
  ): unknown => {
    if (forms.length === 0) return value;
    if (typeof value === "string") {
      const scrubbed = scrubText(value, { cutTail: options?.cutTail === true && !isKey });
      if (scrubbed.text === value) return value;
      for (const name of scrubbed.names) names.add(name);
      return scrubbed.names.length > 0 && options?.changed !== undefined
        ? options.changed(scrubbed.text, value)
        : scrubbed.text;
    }
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      value.forEach((item, index) => {
        const next = scrubDeep(item, names, options);
        if (next !== item) {
          copy ??= [...value];
          copy[index] = next;
        }
      });
      return copy ?? value;
    }
    if (value !== null && typeof value === "object") {
      let copy: Record<string, unknown> | undefined;
      const record = value as Record<string, unknown>;
      for (const [key, item] of Object.entries(record)) {
        const nextItem = scrubDeep(item, names, options);
        const nextKey = scrubDeep(key, names, options, true) as string;
        if (nextItem === item && nextKey === key) continue;
        copy ??= { ...record };
        if (nextKey !== key) {
          delete copy[key];
          let unique = nextKey;
          for (let suffix = 2; unique in copy; suffix += 1) unique = `${nextKey} ${suffix}`;
          copy[unique] = nextItem;
        } else {
          copy[key] = nextItem;
        }
      }
      return copy ?? value;
    }
    return value;
  };

  /** The names of watched values a JSON-like value holds: for callers that refuse instead. */
  const contains = (value: unknown): ReadonlyArray<string> => {
    const names = new Set<string>();
    scrubDeep(value, names);
    return [...names];
  };

  /**
   * One piece of text ingestion appends to a buffer (a message's text, a
   * command's output): joined with what the buffer held back, its whole
   * values hidden, and the tail that could start a value held back again.
   * The state lives with the buffer it belongs to; release `state.held` as it
   * is when the buffer closes.
   */
  const holdPiece = (state: HeldText | undefined, piece: string): HoldResult => {
    if (forms.length === 0 && state === undefined) {
      return { out: piece, state: undefined, names: [] };
    }
    let rest = piece;
    let open = state?.open;
    if (open !== undefined) {
      const { form, offset } = open;
      let index = 0;
      while (
        index < rest.length &&
        offset + index < form.text.length &&
        rest[index] === form.text[offset + index]
      ) {
        index += 1;
      }
      open =
        index === rest.length && offset + index < form.text.length
          ? { form, offset: offset + index }
          : undefined;
      rest = rest.slice(index);
    }
    // Text already sent that a value may still continue from (a message
    // reopened after its tail was released): matched against, never re-sent.
    const sent = state?.sent ?? "";
    const joined = (state?.held ?? "") + rest;
    const full = sent + joined;
    const matches = findMatches(full)
      .filter((match) => match.end > sent.length)
      .map((match) => ({
        ...match,
        start: Math.max(match.start, sent.length) - sent.length,
        end: match.end - sent.length,
      }));
    const last = matches.at(-1);
    if (last !== undefined) open = last.open;
    const lastEnd = sent.length + (last?.end ?? 0);
    const tailLength = open !== undefined ? 0 : startingTail(full.slice(lastEnd), 1);
    const tailStart = full.length - tailLength;
    const heldFrom = Math.max(tailStart, sent.length);
    const held = full.slice(heldFrom);
    const stillSent =
      tailLength > 0 && tailStart < sent.length ? full.slice(tailStart, sent.length) : "";
    return {
      out: replaceMatches(joined, matches, joined.length - held.length),
      state:
        held.length === 0 && open === undefined && stillSent.length === 0
          ? undefined
          : { held, open, ...(stillSent.length > 0 ? { sent: stillSent } : {}) },
      names: namesOf(matches),
    };
  };

  /**
   * After a buffer released its held tail (its message completed), what to
   * keep so a piece that reopens it can't complete a value the tail started.
   */
  const afterRelease = (state: HeldText | undefined): HeldText | undefined => {
    const sent = (state?.sent ?? "") + (state?.held ?? "");
    return sent.length === 0 ? undefined : { held: "", open: undefined, sent };
  };

  /** A notice's line, or a neutral one when the line itself would hold a watched value. */
  const noticeLine = (name: string): string => {
    const line = secretHiddenNotice(name);
    return scrubText(line).text === line ? line : secretHiddenNotice(NEUTRAL_NAME);
  };

  return {
    holdPiece,
    afterRelease,
    noticeLine,
    watch,
    gone,
    scrubText,
    scrubDeep,
    contains,
    findMatches,
    replaceMatches,
    startingTail,
    get size() {
      return entries.length;
    },
  };
}

export type SecretScrubberCore = ReturnType<typeof makeSecretScrubberCore>;

// ---------------------------------------------------------------------------
// Provider events: each one alone, plus question memory and the notice.

/** The provider's own message, replaced once the event hid anything. */
const hiddenRaw = (event: ProviderRuntimeEvent): ProviderRuntimeEvent["raw"] =>
  event.raw === undefined ? undefined : { ...event.raw, payload: { hidden: true } };

/** The notice's line, short enough for one row; the advice is its detail. */
export const secretHiddenNotice = (name: string) => `Hid ${name} in the agent's output`;
export const SECRET_HIDDEN_DETAIL = "The agent may have seen it. Replace the key if that matters.";

/** The kind the timeline gives its own row (session-logic.ts). */
export const SECRET_HIDDEN_WARNING_KIND = "secret-hidden";

/** Names already noticed per thread and turn, shared by the provider hook and ingestion. */
export function makeNoticeMemory() {
  const noticed = new Map<string, Set<string>>();
  return {
    /** The names not yet noticed in this thread's turn; they count as noticed now. */
    take(threadId: string, turnId: string | undefined, names: Iterable<string>): string[] {
      const key = `${threadId}\u0000${turnId ?? ""}`;
      const seen = noticed.get(key) ?? new Set<string>();
      noticed.set(key, seen);
      const fresh = [...names].filter((name) => !seen.has(name));
      for (const name of fresh) seen.add(name);
      return fresh;
    },
    forgetThread(threadId: string) {
      const prefix = `${threadId}\u0000`;
      for (const key of noticed.keys()) if (key.startsWith(prefix)) noticed.delete(key);
    },
  };
}

export type NoticeMemory = ReturnType<typeof makeNoticeMemory>;

/** Every string and member name in a JSON-like value. */
function stringsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      stringsIn(item, into);
    }
  }
  return into;
}

const isStreamPiece = (
  event: ProviderRuntimeEvent,
): event is Extract<
  ProviderRuntimeEvent,
  { readonly type: "content.delta" | "turn.proposed.delta" }
> => event.type === "content.delta" || event.type === "turn.proposed.delta";

/**
 * The provider hook: every event alone, before anything stores, logs or sends
 * it. Whole values are hidden in `payload` and `raw.payload`; a stream piece
 * is never cut, since only ingestion knows which pieces it joins and holds
 * them there. A question or approval remembers what it was shown with, for
 * the answer.
 */
export function makeRuntimeEventScrubber(core: SecretScrubberCore, notices: NoticeMemory) {
  /** Per session and request: each string a question or approval was shown with, and its original. */
  const originals = new Map<string, Map<string, string>>();
  const requestKey = (session: string, requestId: string) => `${session}\u0000${requestId}`;

  const scrubPiece = (
    event: Extract<
      ProviderRuntimeEvent,
      { readonly type: "content.delta" | "turn.proposed.delta" }
    >,
    names: Set<string>,
  ): ProviderRuntimeEvent => {
    const scrubbed = core.scrubText(event.payload.delta);
    for (const name of scrubbed.names) names.add(name);
    const rawPayload =
      event.raw === undefined ? undefined : core.scrubDeep(event.raw.payload, names);
    if (scrubbed.text === event.payload.delta && rawPayload === event.raw?.payload) return event;
    return {
      ...event,
      payload: { ...event.payload, delta: scrubbed.text },
      raw: hiddenRaw(event),
    } as ProviderRuntimeEvent;
  };

  /** Any other event: hide in `payload` and `raw.payload`; remember what a question was shown with. */
  const scrubWhole = (event: ProviderRuntimeEvent, names: Set<string>): ProviderRuntimeEvent => {
    const remembers =
      (event.type === "request.opened" || event.type === "user-input.requested") &&
      event.requestId !== undefined;
    const shown = remembers ? new Map<string, string>() : undefined;
    // Every text the question already holds: a hidden one must not read the same.
    const taken = remembers ? stringsIn(event.payload) : undefined;
    // Two texts hidden to the same string stay two, and never match a text the
    // question already had: the answer is keyed by them.
    const changed = shown
      ? (hidden: string, original: string) => {
          let unique = hidden;
          for (
            let suffix = 2;
            (shown.has(unique) && shown.get(unique) !== original) || taken?.has(unique) === true;
            suffix += 1
          ) {
            unique = `${hidden} (${suffix})`;
          }
          shown.set(unique, original);
          return unique;
        }
      : undefined;
    const payload = core.scrubDeep(event.payload, names, {
      // A question's text is its id for some providers: never cut there.
      cutTail: !remembers,
      ...(changed !== undefined ? { changed } : {}),
    });
    const rawPayload =
      event.raw === undefined ? undefined : core.scrubDeep(event.raw.payload, names);
    if (shown !== undefined && shown.size > 0 && event.requestId !== undefined) {
      originals.set(requestKey(event.threadId, event.requestId), shown);
    }
    if (payload === event.payload && rawPayload === event.raw?.payload) return event;
    return {
      ...event,
      payload,
      ...(event.raw === undefined
        ? {}
        : {
            raw:
              payload !== event.payload ? hiddenRaw(event) : { ...event.raw, payload: rawPayload },
          }),
    } as ProviderRuntimeEvent;
  };

  const forget = (event: ProviderRuntimeEvent) => {
    if (
      (event.type === "request.resolved" || event.type === "user-input.resolved") &&
      event.requestId !== undefined
    ) {
      originals.delete(requestKey(event.threadId, event.requestId));
    }
    if (event.type === "session.exited") {
      const prefix = `${event.threadId}\u0000`;
      for (const key of originals.keys()) if (key.startsWith(prefix)) originals.delete(key);
    }
  };

  /** One notice per name per turn, after the event that hid it. */
  const noticesFor = (event: ProviderRuntimeEvent, names: Set<string>): ProviderRuntimeEvent[] => {
    if (names.size === 0) return [];
    const thread = parseSessionKey(event.threadId as ThreadId).threadId;
    return notices.take(thread, event.turnId, names).map(
      (name) =>
        ({
          eventId: EventId.make(randomUUID()),
          provider: event.provider,
          ...(event.providerInstanceId !== undefined
            ? { providerInstanceId: event.providerInstanceId }
            : {}),
          threadId: event.threadId,
          createdAt: event.createdAt,
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          type: "runtime.warning",
          payload: {
            message: core.noticeLine(name),
            warningKind: SECRET_HIDDEN_WARNING_KIND,
            detail: SECRET_HIDDEN_DETAIL,
          },
        }) as ProviderRuntimeEvent,
    );
  };

  /**
   * One provider event in, the events to publish in order out: the event
   * with whole watched values hidden, and a notice after it. Nothing
   * watched: the same event, alone.
   */
  const scrubRuntimeEvent = (event: ProviderRuntimeEvent): ReadonlyArray<ProviderRuntimeEvent> => {
    if (core.size === 0) {
      if (originals.size > 0) forget(event);
      return [event];
    }
    const names = new Set<string>();
    const scrubbed = isStreamPiece(event) ? scrubPiece(event, names) : scrubWhole(event, names);
    forget(event);
    const after = noticesFor(event, names);
    return after.length === 0 ? [scrubbed] : [scrubbed, ...after];
  };

  /**
   * An answer on its way back to the provider: any string or member name
   * that equals one the question was shown with is put back to the original.
   */
  const restoreAnswer = <A>(session: string, requestId: string, answer: A): A => {
    const changed = originals.get(requestKey(session, requestId));
    if (changed === undefined) return answer;
    const restore = (value: unknown): unknown => {
      if (typeof value === "string") return changed.get(value) ?? value;
      if (Array.isArray(value)) return value.map(restore);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, item]) => [
            changed.get(key) ?? key,
            restore(item),
          ]),
        );
      }
      return value;
    };
    return restore(answer) as A;
  };

  return { scrubRuntimeEvent, restoreAnswer };
}

export type RuntimeEventScrubber = ReturnType<typeof makeRuntimeEventScrubber>;
