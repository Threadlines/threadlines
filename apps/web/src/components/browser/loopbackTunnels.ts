import type {
  DesktopBridge,
  DesktopPreviewTunnelReply,
  DesktopPreviewTunnelRequest,
  EnvironmentApi,
  EnvironmentId,
} from "@threadlines/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import {
  getSavedEnvironmentRecord,
  readEnvironmentDescriptor,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime/catalog";

/**
 * Carries the in-app browser's loopback tunnels over this window's
 * connections to other computers.
 *
 * A thread on another computer has its browser here, and its pages'
 * `localhost` traffic is sent to that computer: the desktop's proxy turns each
 * connection into a tunnel request, and this opens the tunnel on the
 * computer's server over the connection the window already holds (see
 * `PreviewLoopbackProxy.ts` in the desktop and `previewTunnel.ts` in
 * contracts). Nothing here looks at the bytes.
 *
 * Over the relay it refuses rather than carries: the relay counts every
 * message against a daily allowance, and a dev server's page load is
 * thousands of them.
 */

/** Credits are sent in batches of at least this, or at the end of the turn. */
const CREDIT_BATCH_BYTES = 64 * 1024;

interface Tunnel {
  readonly environmentId: EnvironmentId;
  readonly api: EnvironmentApi;
  opened: boolean;
  done: boolean;
  nextSeq: number;
  /** What the page wrote before the tunnel opened, sent in order once it does. */
  readonly beforeOpen: Array<{ readonly data?: Uint8Array; readonly end?: true }>;
  owedCredit: number;
  creditScheduled: boolean;
  stop: () => void;
}

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  if (typeof native === "function") return native(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function computerLabel(environmentId: EnvironmentId): string {
  return (
    getSavedEnvironmentRecord(environmentId)?.label ??
    readEnvironmentDescriptor(environmentId)?.label ??
    "the other computer"
  );
}

/** Why a tunnel could not be opened or broke, in words for the page. */
function failureSentence(environmentId: EnvironmentId, failure: unknown): string {
  const detail =
    typeof (failure as { detail?: unknown } | null)?.detail === "string"
      ? (failure as { detail: string }).detail
      : failure instanceof Error
        ? failure.message
        : `The connection to ${computerLabel(environmentId)} closed.`;
  return `${computerLabel(environmentId)}: ${detail}`;
}

/**
 * Whether a tunnel to this environment can be opened now, or the sentence
 * saying why not.
 */
function refusal(environmentId: EnvironmentId, host: string, port: number): string | null {
  const label = computerLabel(environmentId);
  const descriptor = readEnvironmentDescriptor(environmentId);
  if (descriptor === null || readEnvironmentApi(environmentId) === undefined) {
    return `${label} is not connected, so ${host}:${port} there can't be reached.`;
  }
  if (descriptor.capabilities.browserLoopbackTunnel !== true) {
    return `${label} runs an older Threadlines that can't open its ${host}:${port} here. Update it, then reload.`;
  }
  if (useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.route === "relay") {
    return `${host}:${port} on ${label} can't be opened through the relay. It works when this computer reaches ${label} directly, on the same network or over Tailscale.`;
  }
  return null;
}

/**
 * Serves the desktop's tunnels from this window until the returned call. A
 * no-op outside the desktop app.
 */
export function serveLoopbackTunnels(
  bridge: Pick<DesktopBridge, "servePreviewTunnels"> | undefined = window.desktopBridge,
): () => void {
  const serve = bridge?.servePreviewTunnels;
  if (serve === undefined) return () => {};
  const tunnels = new Map<string, Tunnel>();
  let reply: (message: DesktopPreviewTunnelReply) => void = () => {};

  const finish = (tunnelId: string, error?: string) => {
    const tunnel = tunnels.get(tunnelId);
    if (tunnel === undefined || tunnel.done) return;
    tunnel.done = true;
    tunnels.delete(tunnelId);
    tunnel.stop();
    reply(error === undefined ? { type: "closed", tunnelId } : { type: "closed", tunnelId, error });
  };

  const send = (
    tunnelId: string,
    tunnel: Tunnel,
    chunk: { readonly data?: Uint8Array; readonly end?: true },
  ) => {
    const seq = tunnel.nextSeq;
    tunnel.nextSeq += 1;
    const bytes = chunk.data?.byteLength ?? 0;
    void tunnel.api.previewLoopback
      .write({
        tunnelId,
        seq,
        ...(chunk.data === undefined ? {} : { data: toBase64(chunk.data) }),
        ...(chunk.end === true ? { end: true as const } : {}),
      })
      .then(
        () => {
          if (tunnel.done) return;
          if (bytes > 0) reply({ type: "written", tunnelId, bytes });
          if (chunk.end === true) reply({ type: "finished", tunnelId });
        },
        (failure: unknown) => finish(tunnelId, failureSentence(tunnel.environmentId, failure)),
      );
  };

  const flushCredit = (tunnelId: string, tunnel: Tunnel) => {
    tunnel.creditScheduled = false;
    if (tunnel.done || tunnel.owedCredit === 0) return;
    const bytes = tunnel.owedCredit;
    tunnel.owedCredit = 0;
    // A credit lost with the connection matters to nobody: the tunnel went too.
    void tunnel.api.previewLoopback.credit({ tunnelId, bytes }).catch(() => undefined);
  };

  const open = (request: Extract<DesktopPreviewTunnelRequest, { type: "open" }>) => {
    const { tunnelId, environmentId, host, port } = request;
    const refused = refusal(environmentId, host, port);
    const api = readEnvironmentApi(environmentId);
    if (refused !== null || api === undefined) {
      reply({ type: "closed", tunnelId, error: refused ?? `${host}:${port} can't be reached.` });
      return;
    }
    const tunnel: Tunnel = {
      environmentId,
      api,
      opened: false,
      done: false,
      nextSeq: 0,
      beforeOpen: [],
      owedCredit: 0,
      creditScheduled: false,
      stop: () => {},
    };
    tunnels.set(tunnelId, tunnel);
    tunnel.stop = api.previewLoopback.open(
      { tunnelId, host, port },
      (event) => {
        if (tunnel.done) return;
        if (event._tag === "opened") {
          tunnel.opened = true;
          reply({ type: "opened", tunnelId });
          for (const chunk of tunnel.beforeOpen.splice(0)) send(tunnelId, tunnel, chunk);
        } else if (event._tag === "data") {
          reply({ type: "data", tunnelId, data: fromBase64(event.data) });
        } else {
          reply({ type: "end", tunnelId });
        }
      },
      (failure) =>
        finish(
          tunnelId,
          failure === undefined ? undefined : failureSentence(environmentId, failure),
        ),
    );
  };

  const service = serve((request) => {
    if (request.type === "open") {
      open(request);
      return;
    }
    const tunnel = tunnels.get(request.tunnelId);
    if (tunnel === undefined) return;
    switch (request.type) {
      case "write":
      case "end": {
        const chunk = request.type === "write" ? { data: request.data } : { end: true as const };
        if (tunnel.opened) send(request.tunnelId, tunnel, chunk);
        else tunnel.beforeOpen.push(chunk);
        return;
      }
      case "credit":
        tunnel.owedCredit += request.bytes;
        if (tunnel.owedCredit >= CREDIT_BATCH_BYTES) {
          flushCredit(request.tunnelId, tunnel);
        } else if (!tunnel.creditScheduled) {
          tunnel.creditScheduled = true;
          setTimeout(() => flushCredit(request.tunnelId, tunnel), 0);
        }
        return;
      case "close":
        // The page let go; nothing to tell it.
        tunnel.done = true;
        tunnels.delete(request.tunnelId);
        tunnel.stop();
        return;
    }
  });
  reply = service.send;

  return () => {
    // Deleting the entry being visited is safe for a Map's iterator.
    for (const tunnelId of tunnels.keys()) finish(tunnelId, "Threadlines' window closed.");
    service.stop();
  };
}
