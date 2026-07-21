import type { ProviderRealtimeAudioChunk, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

const REALTIME_AUDIO_SUBSCRIBER_BUFFER_SIZE = 256;

export interface RealtimeAudioHubShape {
  readonly publish: (threadId: ThreadId, audio: ProviderRealtimeAudioChunk) => Effect.Effect<void>;
  readonly subscribe: (threadId: ThreadId) => Stream.Stream<ProviderRealtimeAudioChunk>;
  readonly remove: (threadId: ThreadId) => Effect.Effect<void>;
}

const channels = Effect.runSync(
  SynchronizedRef.make(new Map<ThreadId, PubSub.PubSub<ProviderRealtimeAudioChunk>>()),
);

const channelFor = (threadId: ThreadId) =>
  SynchronizedRef.modifyEffect(channels, (current) => {
    const existing = current.get(threadId);
    if (existing) {
      return Effect.succeed([existing, current] as const);
    }
    return PubSub.sliding<ProviderRealtimeAudioChunk>(REALTIME_AUDIO_SUBSCRIBER_BUFFER_SIZE).pipe(
      Effect.map((channel) => {
        const next = new Map(current);
        next.set(threadId, channel);
        return [channel, next] as const;
      }),
    );
  });

export const realtimeAudioHub = {
  publish: (threadId, audio) =>
    channelFor(threadId).pipe(
      Effect.flatMap((channel) => PubSub.publish(channel, audio)),
      Effect.asVoid,
    ),
  subscribe: (threadId) => Stream.unwrap(channelFor(threadId).pipe(Effect.map(Stream.fromPubSub))),
  remove: (threadId) =>
    SynchronizedRef.modify(channels, (current) => {
      const existing = current.get(threadId);
      if (!existing) {
        return [undefined, current] as const;
      }
      const next = new Map(current);
      next.delete(threadId);
      return [existing, next] as const;
    }).pipe(
      // Shutdown ends subscriber streams so WS audio subscriptions complete
      // instead of hanging on a channel nothing will publish to again.
      Effect.flatMap((channel) => (channel ? PubSub.shutdown(channel) : Effect.void)),
    ),
} satisfies RealtimeAudioHubShape;
