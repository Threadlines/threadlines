/**
 * The browser's way back to the agent's `localhost`.
 *
 * A thread's browser can run on a different computer from its agent: the user
 * works on one machine while the threads run on another. The agent means its
 * own machine when it says `http://localhost:5173`, so the client's browser
 * sends loopback traffic for that thread's pages here, one TCP connection per
 * tunnel, over the connection it already has to the server. The server opens
 * the same connection on its own loopback and passes bytes both ways.
 *
 * Only loopback. A tunnel to anywhere else would make every client an open
 * proxy into the server's network, and the pages that need one are the ones
 * the agent is serving to itself.
 *
 * Advertised by servers with `browserLoopbackTunnel`.
 */
import * as Schema from "effect/Schema";

import { PortSchema } from "./baseSchemas.ts";

/**
 * How many bytes the server sends down a tunnel before the client says it has
 * delivered them. Past it the server stops reading the socket, so a page that
 * stops reading holds the dev server up rather than filling memory in between.
 */
export const PREVIEW_TUNNEL_WINDOW_BYTES = 1024 * 1024;

/** The most one write or one data event carries, before base64. */
export const PREVIEW_TUNNEL_CHUNK_BYTES = 256 * 1024;

const TunnelId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const PreviewTunnelOpenSchema = Schema.Struct({
  /** Chosen by the client, so its writes can name the tunnel before it opens. */
  tunnelId: TunnelId,
  /** `localhost`, a `*.localhost` name, `127.x.x.x` or `::1`. Anything else is refused. */
  host: Schema.String,
  port: PortSchema,
});
export type PreviewTunnelOpen = typeof PreviewTunnelOpenSchema.Type;

/**
 * What the server sends down an open tunnel. The subscription ends when the
 * connection has closed both ways, and fails when it could not open or broke.
 *
 * - `opened`: connected; bytes may flow.
 * - `data`: bytes from the server's side, base64.
 * - `end`: the server's side has finished sending. The client may still write.
 */
export const PreviewTunnelEventSchema = Schema.Union([
  Schema.TaggedStruct("opened", {}),
  Schema.TaggedStruct("data", { data: Schema.String }),
  Schema.TaggedStruct("end", {}),
]);
export type PreviewTunnelEvent = typeof PreviewTunnelEventSchema.Type;

/**
 * Bytes for the server's side of a tunnel, in order.
 *
 * Numbered because the server may start handling one call before the one sent
 * ahead of it. `end` travels in the same sequence, so finishing never overtakes
 * the last bytes. Answered once the bytes are written out, which is what keeps
 * a client from writing faster than the socket drains.
 */
export const PreviewTunnelWriteSchema = Schema.Struct({
  tunnelId: TunnelId,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Base64. */
  data: Schema.optionalKey(Schema.String),
  /** The client's side has finished sending. */
  end: Schema.optionalKey(Schema.Literal(true)),
});
export type PreviewTunnelWrite = typeof PreviewTunnelWriteSchema.Type;

/** The client delivered this many more bytes of the tunnel's data to the page. */
export const PreviewTunnelCreditSchema = Schema.Struct({
  tunnelId: TunnelId,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewTunnelCredit = typeof PreviewTunnelCreditSchema.Type;

export const PreviewTunnelFailureReason = Schema.Literals([
  /** The host is not a loopback address on the server's machine. */
  "notLoopback",
  /** Nothing is listening there, or it could not be reached. */
  "unreachable",
  /** The connection broke after it opened. */
  "broken",
  /** Too many tunnels are open, or a write arrived out of all proportion. */
  "limit",
  /** A write named a tunnel this connection does not have open. */
  "unknownTunnel",
]);
export type PreviewTunnelFailureReason = typeof PreviewTunnelFailureReason.Type;

export class PreviewTunnelError extends Schema.TaggedError<PreviewTunnelError>()(
  "PreviewTunnelError",
  {
    reason: PreviewTunnelFailureReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A server listening on the environment's machine, offered as a destination. */
export const PreviewLocalServerSchema = Schema.Struct({
  port: Schema.Number,
  processName: Schema.String,
  pid: Schema.Number,
  /** The served page's title, which identifies a server better than "node". */
  title: Schema.NullOr(Schema.String),
});
export type PreviewLocalServer = typeof PreviewLocalServerSchema.Type;
