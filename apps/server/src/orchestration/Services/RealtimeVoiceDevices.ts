/**
 * RealtimeVoiceDevices - which device is speaking in each thread's voice
 * session. The WebSocket route notes it as audio arrives; runtime ingestion
 * reads it when it writes down what the user said, so a spoken message is
 * recorded with the device it came from (MessageSentFrom), like a typed one.
 * Kept in memory: a voice session never outlives the server. Optional: a
 * server without it records voice transcripts with no device.
 *
 * @module RealtimeVoiceDevices
 */
import type { MessageSentFrom, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface RealtimeVoiceDevicesShape {
  /** Audio from `sentFrom` (undefined: a device of unknown kind) reached `threadId`'s session. */
  readonly noteSpeaker: (
    threadId: ThreadId,
    sentFrom: MessageSentFrom | undefined,
  ) => Effect.Effect<void>;
  /**
   * The device that spoke the user's message whose transcript just finished
   * in `threadId`'s session: the one whose audio came first since the last
   * finished message, so a switch of device while a transcript is still on
   * its way does not take it over.
   */
  readonly takeSpeaker: (threadId: ThreadId) => Effect.Effect<MessageSentFrom | undefined>;
}

export class RealtimeVoiceDevices extends Context.Service<
  RealtimeVoiceDevices,
  RealtimeVoiceDevicesShape
>()("threadlines/orchestration/Services/RealtimeVoiceDevices") {}
