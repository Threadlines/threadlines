import type { MessageSentFrom, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RealtimeVoiceDevices } from "../Services/RealtimeVoiceDevices.ts";

/** A device of unknown kind is one of its own. */
type Speaker = MessageSentFrom | null;

const sameSpeaker = (a: Speaker, b: Speaker) =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.name === b.name && a.os === b.os);

export const RealtimeVoiceDevicesLive = Layer.effect(
  RealtimeVoiceDevices,
  Effect.sync(() => {
    // Per thread: who began the message being spoken, and who spoke last.
    const began = new Map<ThreadId, Speaker>();
    const latest = new Map<ThreadId, Speaker>();
    return RealtimeVoiceDevices.of({
      noteSpeaker: (threadId, sentFrom) =>
        Effect.sync(() => {
          const speaker = sentFrom ?? null;
          if (!began.has(threadId)) began.set(threadId, speaker);
          latest.set(threadId, speaker);
        }),
      takeSpeaker: (threadId) =>
        Effect.sync(() => {
          const speaker = began.has(threadId)
            ? began.get(threadId)!
            : (latest.get(threadId) ?? null);
          began.delete(threadId);
          // Someone else spoke since: theirs is the next message.
          const last = latest.get(threadId) ?? null;
          if (!sameSpeaker(last, speaker)) began.set(threadId, last);
          return speaker ?? undefined;
        }),
    });
  }),
);
