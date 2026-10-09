// @effect-diagnostics nodeBuiltinImport:off - Effect has no SOCKS proxy or address block list.
/**
 * The SOCKS5 proxy every connection of the page preview browser goes
 * through. It only opens tunnels to a few public CDNs, named by exact
 * hostname, and only to the addresses it checked for them.
 *
 * Ported from T3 Code's `htmlRender/publicProxy.ts` (MIT), which shares this
 * repo's ancestry. T3's proxy reaches any public address; this one also holds
 * pages to the hosts a published page may load from.
 *
 * @module pages/preview/previewProxy
 */
import { AGENT_PAGE_ALLOWED_HOSTS } from "@threadlines/shared/agentPages";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";

import { isPublicAddress } from "../../provider/managedRuntime/HttpsFetch.ts";

/**
 * The hosts a page may load from in a preview, by exact name. Pages load
 * libraries, styles, and fonts from these CDNs; nothing else is reachable.
 */
export const PAGE_PREVIEW_ALLOWED_HOSTS: ReadonlyArray<string> = AGENT_PAGE_ALLOWED_HOSTS;

/**
 * IPv6 ranges `isPublicAddress` lets through that carry an IPv4 address a
 * translator may route to without checking it: local-use NAT64 and Teredo.
 */
const TRANSLATED_ADDRESSES = new NodeNet.BlockList();
TRANSLATED_ADDRESSES.addSubnet("64:ff9b:1::", 48, "ipv6");
TRANSLATED_ADDRESSES.addSubnet("2001::", 32, "ipv6");

const NAT64 = new NodeNet.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new NodeNet.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

/** The sixteen-bit groups of an IPv6 address, which may end in dotted IPv4. */
const ipv6Groups = (address: string) => {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

/**
 * The IPv4 address a NAT64 or 6to4 address stands for, which a translator
 * will route to, so it is checked as well. Public NAT64 targets stay
 * reachable, as on IPv6-only networks.
 */
const embeddedIPv4 = (address: string) => {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

/** The addresses this machine's interfaces hold right now. */
const ownAddresses = () => {
  const own = new NodeNet.BlockList();
  for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
};

/**
 * Whether a page may connect to `address`: a public address that is not one
 * this machine holds (a public one included), nor an IPv6 form of a local
 * IPv4 address. The block lists match IPv4-mapped IPv6 against IPv4 entries.
 */
export const isReachableAddress = (address: string, family: number): boolean => {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (!isPublicAddress(address) || ownAddresses().check(address, type)) return false;
  if (family !== 6) return true;
  if (TRANSLATED_ADDRESSES.check(address, "ipv6")) return false;
  const embedded = embeddedIPv4(address);
  return embedded === undefined || isReachableAddress(embedded, 4);
};

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export interface PreviewProxyOptions {
  /** Default: `PAGE_PREVIEW_ALLOWED_HOSTS`. */
  readonly allowedHosts?: ReadonlyArray<string>;
  /** Test seam: every address of a name. Default: the system resolver. */
  readonly resolve?: (host: string) => Promise<ReadonlyArray<ResolvedAddress>>;
  /** Test seam: which resolved addresses a tunnel may reach. Default: `isReachableAddress`. */
  readonly isReachable?: (address: string, family: number) => boolean;
}

const systemResolve = (host: string) =>
  NodeDnsPromises.lookup(host, { all: true, verbatim: true }) as Promise<
    ReadonlyArray<ResolvedAddress>
  >;

// SOCKS5 (RFC 1928) replies: success, refused by rule, command unsupported.
const REPLY_SUCCEEDED = 0;
const REPLY_NOT_ALLOWED = 2;
const REPLY_UNSUPPORTED = 7;
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

// What a client may send before its tunnel opens; a TLS hello fits easily.
const MAX_EARLY_BYTES = 64 * 1024;

/**
 * Answers and closes. The client is never read from again, so anything it
 * sent after its request is dropped rather than left buffered.
 */
const refuse = (client: NodeNet.Socket, code: number) => {
  client.end(reply(code), () => client.destroy());
};

/**
 * The CONNECT target in a complete SOCKS5 request, or "short" when more bytes
 * are needed. `host` is undefined for an address target: pages only ever
 * reach hosts by name.
 */
const readRequest = (data: Buffer) => {
  if (data.length < 5) return "short" as const;
  // Version 5, reserved byte 0.
  if (data[0] !== 5 || data[2] !== 0) return undefined;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  return {
    command: data[1],
    host: type === 3 ? data.subarray(5, 5 + data[4]!).toString("latin1") : undefined,
    port: data.readUInt16BE(end - 2),
    rest: data.subarray(end),
  };
};

/**
 * Starts the proxy on loopback for the life of the scope and returns its
 * port. It carries bytes only, so HTTP, TLS, and WebSockets pass through
 * unchanged. A tunnel opens only to an allowed host whose every address is
 * reachable, and connects only to those checked addresses, so a name that
 * later resolves elsewhere (DNS rebinding) changes nothing.
 */
export const previewProxy = (options: PreviewProxyOptions = {}) => {
  const allowedHosts = new Set(
    (options.allowedHosts ?? PAGE_PREVIEW_ALLOWED_HOSTS).map((host) => host.toLowerCase()),
  );
  const resolve = options.resolve ?? systemResolve;
  const isReachable = options.isReachable ?? isReachableAddress;

  /** The addresses to connect to for an allowed `host`, or undefined to refuse it. */
  const checkedAddresses = async (host: string | undefined) => {
    const name = host?.toLowerCase().replace(/\.$/u, "");
    if (name === undefined || !allowedHosts.has(name)) return undefined;
    const addresses = await resolve(name).catch(() => []);
    if (addresses.length === 0) return undefined;
    return addresses.every(({ address, family }) => isReachable(address, family))
      ? addresses
      : undefined;
  };

  return Effect.acquireRelease(
    Effect.callback<
      { readonly server: NodeNet.Server; readonly sockets: Set<NodeNet.Socket> },
      Error
    >((resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const track = (socket: NodeNet.Socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        return socket;
      };
      const server = NodeNet.createServer((client) => {
        track(client);
        let data = Buffer.alloc(0);
        let greeted = false;
        const onData = (chunk: Buffer) => {
          data = Buffer.concat([data, chunk]);
          if (!greeted) {
            if (data.length < 2 || data.length < 2 + data[1]!) return;
            // Version 5, offering "no authentication".
            if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
              return void client.end(Buffer.from([5, 0xff]));
            }
            data = data.subarray(2 + data[1]!);
            greeted = true;
            client.write(Buffer.from([5, 0]));
          }
          const request = readRequest(data);
          if (request === "short") return;
          client.off("data", onData);
          if (request === undefined || request.command !== 1 || request.port === 0) {
            return refuse(client, REPLY_UNSUPPORTED);
          }
          // Keeps reading while the target resolves, so a client that leaves is
          // noticed, and holds what it sends early up to a small cap.
          const early: Array<Buffer> = [request.rest];
          let earlyBytes = request.rest.length;
          const holdEarly = (chunk: Buffer) => {
            earlyBytes += chunk.length;
            if (earlyBytes > MAX_EARLY_BYTES) return void client.destroy();
            early.push(chunk);
          };
          client.on("data", holdEarly);
          void checkedAddresses(request.host).then((addresses) => {
            if (client.destroyed) return;
            client.off("data", holdEarly);
            if (addresses === undefined) return refuse(client, REPLY_NOT_ALLOWED);
            client.pause();
            // Tries every checked address, IPv6 and IPv4 alike, so a host is
            // still reached on a network whose IPv6 route is broken. `lookup`
            // hands back only the checked addresses.
            const upstream = track(
              NodeNet.connect({
                host: request.host!,
                port: request.port,
                autoSelectFamily: true,
                lookup: (_host, lookupOptions, callback) =>
                  lookupOptions.all
                    ? callback(null, [...addresses])
                    : callback(null, addresses[0]!.address, addresses[0]!.family),
              }),
            );
            upstream.once("connect", () => {
              client.write(reply(REPLY_SUCCEEDED));
              for (const chunk of early) upstream.write(chunk);
              upstream.pipe(client);
              client.pipe(upstream);
            });
            upstream.on("close", () => client.destroy());
            client.on("close", () => upstream.destroy());
          });
        };
        client.on("data", onData);
      });
      // A failure to listen fails this preview; once listening, a server error
      // must not reach Node as an unhandled event either.
      let listening = false;
      server.on("error", (error) => {
        if (!listening) resume(Effect.fail(error));
      });
      server.listen(0, "127.0.0.1", () => {
        listening = true;
        resume(Effect.succeed({ server, sockets }));
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.map(({ server }) => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : 0;
    }),
  );
};
