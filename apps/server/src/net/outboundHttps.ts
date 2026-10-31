/**
 * Calls the computer makes to addresses the user typed in (assistants'
 * alerts; docs/design/assistants.md, step 4), under one set of network
 * rules, so an address can't be used to reach this computer, its network or
 * a cloud's metadata service:
 *
 * - `https:` only, with no user or password in the URL;
 * - every address the host resolves to must be public (IPv4 and IPv6, with
 *   IPv4-mapped and NAT64 addresses judged by the IPv4 inside them); one
 *   private answer refuses the call;
 * - the connection goes to an address that was checked (a fixed `lookup`),
 *   with the host name kept for TLS and `Host`, so DNS can't change between
 *   the check and the connect;
 * - its own direct agent, never the global one, which Node can send through
 *   `HTTPS_PROXY`;
 * - no redirects, 10 seconds for the whole call, at most 64 KiB of the answer
 *   read.
 *
 * Honest limit: a network-specific NAT64 prefix looks public and can't be
 * told apart.
 */
import * as Effect from "effect/Effect";
import * as dns from "node:dns";
import * as https from "node:https";
import * as net from "node:net";

const blockList = (
  ipv4: ReadonlyArray<readonly [string, number]>,
  ipv6: ReadonlyArray<readonly [string, number]>,
) => {
  const list = new net.BlockList();
  for (const [address, prefix] of ipv4) list.addSubnet(address, prefix, "ipv4");
  for (const [address, prefix] of ipv6) list.addSubnet(address, prefix, "ipv6");
  return list;
};

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is checked against the IPv4 rules by BlockList itself. */
const BLOCKED = blockList(
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ],
  [
    // The unspecified and loopback addresses and the old IPv4-compatible form.
    ["::", 96],
    ["::ffff:0:0:0", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ],
);

const NAT64 = blockList([], [["64:ff9b::", 96]]);

/** The IPv4 in the last 32 bits of an IPv6 address Node has normalized. */
const embeddedIpv4 = (address: string) => {
  const tail = address.slice(address.lastIndexOf(":") + 1);
  if (tail.includes(".")) return tail;
  const [head = "", rest = ""] = address.split("::");
  const groups = [...head.split(":"), ...rest.split(":")].filter((group) => group !== "");
  const [high = "0", low = "0"] = groups.length >= 2 ? groups.slice(-2) : ["0", ...groups];
  const value = ((Number.parseInt(high, 16) << 16) | Number.parseInt(low, 16)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
};

/** Whether `address` (an IP literal) is one the rules refuse. Anything that isn't an IP is refused. */
export const isBlockedAddress = (address: string): boolean => {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family !== 6) return true;
  let plain: string;
  try {
    plain = new net.SocketAddress({ address, family: "ipv6" }).address;
  } catch {
    return true;
  }
  if (NAT64.check(plain, "ipv6")) return BLOCKED.check(embeddedIpv4(plain), "ipv4");
  return BLOCKED.check(plain, "ipv6");
};

/** Why an address can't be used, in words for the user. */
export class OutboundAddressError extends Error {
  override readonly name = "OutboundAddressError";
}

export const OUTBOUND_TIMEOUT_MS = 10_000;
const ANSWER_READ_LIMIT = 64 * 1024;

/** Checks the URL's form: https, a host, no credentials. Throws OutboundAddressError. */
export const checkOutboundUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OutboundAddressError("That isn't a web address.");
  }
  if (url.protocol !== "https:") {
    throw new OutboundAddressError("Use an https:// address.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new OutboundAddressError("Leave the user name and password out of the address.");
  }
  if (url.hostname === "") {
    throw new OutboundAddressError("That address has no host.");
  }
  return url;
};

export type Resolved = ReadonlyArray<{ readonly address: string; readonly family: number }>;

/** URL keeps an IPv6 literal in brackets. */
const hostOf = (url: URL) => url.hostname.replace(/^\[(.*)\]$/u, "$1");

/**
 * Resolves the URL's host and checks every address, within `timeoutMs`.
 * Fails with OutboundAddressError. Used when an address is saved, so a typo
 * or a private address shows at once, and before every call.
 */
export const resolveOutbound = (
  raw: string,
  timeoutMs = OUTBOUND_TIMEOUT_MS,
): Effect.Effect<{ readonly url: URL; readonly addresses: Resolved }, OutboundAddressError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => checkOutboundUrl(raw),
      catch: (error) =>
        error instanceof OutboundAddressError
          ? error
          : new OutboundAddressError("That isn't a web address."),
    });
    const host = hostOf(url);
    const family = net.isIP(host);
    const addresses: Resolved =
      family !== 0
        ? [{ address: host, family }]
        : yield* Effect.tryPromise({
            try: () => dns.promises.lookup(host, { all: true, order: "verbatim" }),
            catch: () => new OutboundAddressError(`Couldn't find ${host}.`),
          }).pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () => Effect.fail(new OutboundAddressError(`Couldn't find ${host} in time.`)),
            }),
          );
    if (addresses.length === 0) {
      return yield* Effect.fail(new OutboundAddressError(`Couldn't find ${host}.`));
    }
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      return yield* Effect.fail(
        new OutboundAddressError(
          `${host} points to a private or reserved address, which Threadlines doesn't send to.`,
        ),
      );
    }
    return { url, addresses };
  });

/**
 * How a call went.
 * - `answered`: the receiver gave a status (a 3xx too: redirects aren't followed).
 * - `not_sent`: it plainly never arrived (the address was refused, or DNS,
 *   the connection or TLS failed); safe to try again.
 * - `unknown`: the connection was up but no answer came (a timeout, a
 *   dropped connection); the receiver may have it.
 */
export type OutboundResult =
  | {
      readonly type: "answered";
      readonly status: number;
      /** Seconds from a numeric `Retry-After`. */
      readonly retryAfterSeconds: number | undefined;
    }
  | { readonly type: "not_sent"; readonly detail: string }
  | { readonly type: "unknown"; readonly detail: string };

/** POSTs `body` to `url` under the rules above. Never fails: the result says how it went. */
export const postOutbound = (input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}): Effect.Effect<OutboundResult> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const resolved = yield* resolveOutbound(input.url).pipe(Effect.result);
    if (resolved._tag === "Failure") {
      return { type: "not_sent", detail: resolved.failure.message } satisfies OutboundResult;
    }
    const remaining = Math.max(0, OUTBOUND_TIMEOUT_MS - (Date.now() - startedAt));
    return yield* postToAddresses(
      resolved.success.url,
      resolved.success.addresses,
      input,
      remaining,
    );
  });

/** A `lookup` that answers only with the addresses that were checked. */
const pinnedLookup =
  (addresses: Resolved): net.LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all === true) {
      callback(
        null,
        addresses.map((entry) => ({ address: entry.address, family: entry.family })),
      );
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  };

/**
 * The call itself, to addresses already checked (`resolveOutbound`); the
 * connection never resolves `url`'s host again.
 */
export const postToAddresses = (
  url: URL,
  addresses: Resolved,
  input: { readonly headers: Readonly<Record<string, string>>; readonly body: string },
  timeoutMs: number,
): Effect.Effect<OutboundResult> =>
  Effect.callback<OutboundResult>((resume, signal) => {
    const host = hostOf(url);
    // Its own agent: the global one may go through a proxy that resolves on its own.
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    let request: ReturnType<typeof https.request> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    // Up once TLS is: before that the receiver can't have read a byte.
    let connected = false;
    const finish = (result: OutboundResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      agent.destroy();
      resume(Effect.succeed(result));
    };
    const failed = (detail: string) =>
      finish(connected ? { type: "unknown", detail } : { type: "not_sent", detail });

    try {
      request = https.request({
        host,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        agent,
        headers: {
          ...input.headers,
          host: url.host,
          "content-length": String(Buffer.byteLength(input.body)),
        },
        // Only the addresses that were checked. Node asks for all of them when
        // it races IPv4 and IPv6.
        lookup: pinnedLookup(addresses),
      });
    } catch (error) {
      finish({
        type: "not_sent",
        detail: error instanceof Error ? error.message : "The call couldn't be made.",
      });
      return;
    }
    timer = setTimeout(
      () => failed(connected ? "No answer in time." : "Couldn't connect in time."),
      timeoutMs,
    );
    request.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        connected = true;
      });
    });
    request.on("error", (error) => failed(error.message || "The connection failed."));
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      const retryAfter = Number(response.headers["retry-after"]);
      let read = 0;
      response.on("data", (chunk: Buffer) => {
        read += chunk.length;
        if (read > ANSWER_READ_LIMIT) response.destroy();
      });
      const answered = () =>
        finish({
          type: "answered",
          status,
          retryAfterSeconds:
            response.headers["retry-after"] !== undefined &&
            Number.isFinite(retryAfter) &&
            retryAfter >= 0
              ? retryAfter
              : undefined,
        });
      response.on("end", answered);
      response.on("close", answered);
      response.on("error", answered);
    });
    request.end(input.body);
    signal.addEventListener("abort", () => failed("Stopped."), { once: true });
  });
