// @effect-diagnostics globalDate:off cryptoRandomUUID:off globalConsole:off
import { DurableObject } from "cloudflare:workers";
import type {
  RelayControlEvent,
  RelayDeviceStatusResult,
  RelayHookMintResult,
  RelayHookStatusResult,
  RelayJoinResult,
  RelayPipeId,
  RelayDeviceId,
  RelayWatchEvent,
} from "@threadlines/contracts/relay";
import {
  RELAY_CLOSE_CODE_ACCESS_REMOVED,
  RELAY_CLOSE_CODE_DAILY_LIMIT,
  RELAY_CLOSE_CODE_HOST_OFFLINE,
  RELAY_CLOSE_CODE_PEER_UNAVAILABLE,
  RELAY_CLOSE_CODE_RELAY_BUSY,
  RELAY_CLOSE_CODE_REPLACED,
  RELAY_ERROR_BAD_HOST_SECRET,
  RELAY_ERROR_HOOKS_OFF,
  RELAY_ERROR_STALE_REVISION,
  RELAY_ERROR_UNKNOWN_HOST,
  RELAY_HEARTBEAT_PING_FRAME,
  RELAY_HEARTBEAT_PONG_FRAME,
  RELAY_RAW_CONTROL_PREFIX,
} from "@threadlines/contracts/relay";
import { hookDeliveryAad, sealHookDelivery } from "@threadlines/shared/relayHookSeal";
import { decodePublicKey } from "@threadlines/shared/relaySecure";

import { randomDigits, sha256Base64Url } from "../crypto.ts";
import { log, loggedPath } from "../log.ts";
import { createJsonResponse, parseBearerToken, parseRelayTokenProtocol } from "../protocol.ts";
import { RELAY_WEBSOCKET_PROTOCOL } from "../protocol.ts";
import { codeShardName } from "./codeShardCore.ts";
import { hostLimitsFromEnv, publicRelayOrigin, type RelayV2Env } from "./env.ts";
import {
  type HookDeliveryInput,
  type HookDeliveryOutcome,
  hookMac,
  hookPayload,
  hookUrl,
  isHookId,
  newHookId,
  parseKeptHeaders,
} from "./hooks.ts";
import {
  AWAKE_WINDOW_MS,
  HostCore,
  HostCoreError,
  HostCoreErrorWithEffects,
  type HookAdmission,
  type HostEffect,
  type JoinInput,
  type PendingUsage,
} from "./hostCore.ts";
import { RELAY_LEDGER_NAME } from "./RelayLedger.ts";
import { base64UrlField, hostErrorStatus, joinErrorStatus, parseJoinBody } from "./http.ts";

/** A host that has not sent a lease frame for this long counts as offline (it leases every 60 s). */
const HOST_LEASE_MS = 150_000;
/** Pending usage held on sockets is committed to storage at most this often. */
const USAGE_COMMIT_INTERVAL_MS = 60_000;
/** How long a device's connect waits for the host to attach its end of the pipe. */
const PIPE_ATTACH_TIMEOUT_MS = 10_000;
const LEDGER_BUSY_CACHE_MS = 60_000;
const MAX_BUFFERED_PIPE_FRAMES = 200;
const CODE_CLAIM_ATTEMPTS = 8;
/** Whole deliveries replayed on one (re)connect, in sealed bytes; the rest are announced and fetched. */
const HOOK_REPLAY_INLINE_BYTES = 4 * 1024 * 1024;

type SocketRole = "control" | "device" | "host-pipe" | "watch";

interface SocketAttachment {
  readonly role: SocketRole;
  readonly connectedAt: number;
  readonly deviceId?: string;
  readonly pipeId?: string;
  readonly requestId?: string;
  /** Control sockets only: last lease frame, kept on the socket so it survives hibernation. */
  readonly leaseAt?: number;
  /**
   * Usage tallies not yet committed. Memory is lost whenever the object
   * hibernates, so they ride on socket attachments, which survive it:
   * forwarded frames on each device socket, awake windows on the control
   * socket.
   */
  readonly pendingMessages?: number;
  readonly pendingAwakeSeconds?: number;
  readonly lastAwakeWindow?: number;
  readonly lastCommitAt?: number;
  /**
   * Control sockets only: the ledger's last relay-wide answer and when it was
   * asked, so a woken object doesn't forward on a forgotten "not busy".
   */
  readonly ledgerBusy?: boolean;
  readonly ledgerCheckedAt?: number;
}

type PipeOutcome = "attached" | "not-yet" | "revoked" | "timeout" | "replaced" | "host-offline";

interface PipeReservation {
  readonly deviceId: string;
  readonly pipeId: string;
  readonly settle: (outcome: PipeOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type RelayHostJoinOutcome =
  | { readonly ok: true; readonly result: RelayJoinResult }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * One relay host (one Threadlines server). Holds the host's control socket,
 * per-device data pipes, joiner watch sockets, and the {@link HostCore} state.
 *
 * Every device's data socket is paired with its own host pipe socket (same
 * `pipe:<id>` tag), so devices never see each other's frames. RPC heartbeats
 * are answered at the edge by the auto-response, so idle connections never
 * wake this object; host liveness comes from the control socket's lease.
 */
export class RelayHost extends DurableObject<RelayV2Env> {
  private readonly core: HostCore;
  private readonly reservations = new Map<string, PipeReservation>();
  private readonly earlyPipeFrames = new Map<string, Array<string | ArrayBuffer>>();
  private ledgerBusy = false;
  private ledgerCheckedAt = 0;
  private ledgerRefreshing = false;

  constructor(ctx: DurableObjectState, env: RelayV2Env) {
    super(ctx, env);
    this.core = new HostCore(ctx.storage.sql, hostLimitsFromEnv(env));
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RELAY_HEARTBEAT_PING_FRAME, RELAY_HEARTBEAT_PONG_FRAME),
    );
  }

  // ----- RPC from the worker ---------------------------------------------------

  async initialize(input: {
    readonly hostId: string;
    readonly secretHash: string;
    readonly label: string;
    readonly environmentId: string;
  }): Promise<void> {
    this.core.initialize({ ...input, now: Date.now() });
  }

  async join(input: Omit<JoinInput, "now" | "fresh">): Promise<RelayHostJoinOutcome> {
    const now = Date.now();
    try {
      const outcome = this.core.join({
        ...input,
        now,
        fresh: {
          requestId: crypto.randomUUID(),
          deviceId: crypto.randomUUID(),
        },
      });
      await this.applyEffects(outcome.effects);
      await this.scheduleDeadlines();
      return { ok: true, result: outcome.result };
    } catch (error) {
      if (error instanceof HostCoreErrorWithEffects) {
        await this.applyEffects(error.effects);
      }
      if (error instanceof HostCoreError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
  }

  // ----- HTTP and WebSocket routes ----------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // v2 hosts {h} ...
    const rest = parts.slice(3);
    const method = request.method;
    try {
      if (!this.core.host()) {
        return json(
          {
            error: "This computer is not registered with the relay.",
            code: RELAY_ERROR_UNKNOWN_HOST,
          },
          404,
        );
      }
      const [section, id, action] = rest;
      if (section === "control" && rest.length === 1) {
        return await this.handleControl(request);
      }
      if (section === "hooks" && rest.length === 1) {
        if (method === "POST") return await this.handleMintHook(request);
        if (method === "PUT") return await this.handleSetHooks(request);
        if (method === "GET") return await this.handleHookStatus(request);
      }
      if (section === "hooks" && id === "deliveries" && action && rest.length === 3) {
        if (method === "GET") return await this.handleGetHookDelivery(request, action);
      }
      if (section === "invites" && method === "POST" && rest.length === 1) {
        return await this.handleCreateInvite(request);
      }
      if (section === "invites" && id && method === "DELETE" && rest.length === 2) {
        return await this.handleCancelInvite(request, id);
      }
      // Action routes match exactly, so nothing slips past the join limiter
      // (which counts these same segments) with an extra or empty segment.
      const isAction = rest.length === 3;
      if (section === "invites" && id && action === "claim" && method === "POST" && isAction) {
        return await this.handleClaim(request, id);
      }
      if (section === "requests" && id && (rest.length === 2 || isAction)) {
        if (rest.length === 2 && method === "GET")
          return await this.handleRequestStatus(request, id);
        if (action === "watch") return await this.handleWatch(request, id);
        if (action === "cancel" && method === "POST")
          return await this.handleCancelRequest(request, id);
        if (action === "host-nonce" && method === "POST")
          return await this.handleHostNonce(request, id);
        if (action === "reveal" && method === "POST") return await this.handleReveal(request, id);
        if ((action === "approve" || action === "deny") && method === "POST") {
          return await this.handleDecision(request, id, action);
        }
      }
      if (section === "devices" && id && isAction) {
        if (action === "connect") return await this.handleDeviceConnect(request, id);
        if (action === "status" && method === "GET")
          return await this.handleDeviceStatus(request, id);
        if (action === "revoke" && method === "POST") return await this.handleRevoke(request, id);
      }
      if (section === "pipes" && id && rest.length === 2) {
        return await this.handlePipe(request, id);
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof HostCoreError) {
        if (error instanceof HostCoreErrorWithEffects) {
          await this.applyEffects(error.effects);
        }
        return json({ error: error.message, code: error.code }, hostErrorStatus(error.code));
      }
      log("error", "relay host request failed", {
        path: loggedPath(url.pathname),
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ error: "Relay request failed." }, 500);
    }
  }

  private async requireHostSecret(request: Request, viaProtocol = false): Promise<boolean> {
    const token = viaProtocol
      ? parseRelayTokenProtocol(request.headers.get("Sec-WebSocket-Protocol")).token
      : parseBearerToken(request.headers.get("Authorization"));
    return token !== null && this.core.verifyHostSecretHash(await sha256Base64Url(token));
  }

  private async handleControl(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return json({ error: "Expected WebSocket upgrade." }, 400);
    if (!(await this.requireHostSecret(request, true))) return badHostSecret();

    for (const socket of this.ctx.getWebSockets("control")) {
      socket.close(RELAY_CLOSE_CODE_REPLACED, "Replaced by a newer host connection.");
    }
    const now = Date.now();
    const { client, server } = this.accept(
      ["control"],
      { role: "control", connectedAt: now, leaseAt: now },
      request,
    );

    const pending = this.core.pendingRequests(now);
    await this.applyEffects(pending.effects);
    this.send(server, {
      type: "snapshot",
      requests: pending.result,
      devices: this.core.devices(now),
      usage: this.core.usage(now, this.pendingUsage()),
    } satisfies RelayControlEvent);
    // Every delivery the host hasn't acknowledged comes again, oldest first.
    for (const event of this.core.hookReplay(now, HOOK_REPLAY_INLINE_BYTES)) {
      this.send(server, event);
    }
    return upgradeResponse(client, request);
  }

  // ----- event task hooks ------------------------------------------------------

  /**
   * A webhook delivery whose address, size and body the worker already
   * checked and read (hookRoute.ts). Admits it (hook active, allowances,
   * queue room), seals it to the host's hook key, stores it, and pushes it
   * to the host if connected.
   */
  async deliverHook(input: HookDeliveryInput): Promise<HookDeliveryOutcome> {
    const host = this.core.host();
    if (!host || host.host_id !== input.hostId) return { status: 404 };
    const now = Date.now();
    const admission = this.core.admitHookDelivery({
      hookId: input.hookId,
      now,
      pending: this.pendingUsage(),
    });
    if (!admission.ok) return hookRefusal(admission);

    const deliveryId = crypto.randomUUID();
    const sealed = await sealHookDelivery({
      publicKey: admission.publicKey,
      aad: hookDeliveryAad(input.hostId, input.hookId, deliveryId),
      payload: hookPayload({
        method: input.method,
        query: input.query,
        headers: new Headers(input.headers.map(([name, value]) => [name, value])),
        keptHeaders: admission.keptHeaders,
        body: input.body,
        receivedAt: new Date(now).toISOString(),
      }),
    });
    const stored = this.core.storeHookDelivery({
      deliveryId,
      hookId: input.hookId,
      sealed,
      now,
      pending: this.pendingUsage(),
    });
    if (!stored.result.ok) return hookRefusal(stored.result);
    await this.applyEffects(stored.effects);
    await this.scheduleDeadlines();
    return { status: 202 };
  }

  /** `POST /v2/hosts/{h}/hooks`: a new active hook and its full public address. */
  private async handleMintHook(request: Request): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    const pathKey = this.env.HOOK_PATH_KEY?.trim();
    if (!pathKey) {
      return json({ error: "This relay doesn't take events.", code: RELAY_ERROR_HOOKS_OFF }, 503);
    }
    const body = (await readJson(request)) as Record<string, unknown> | null;
    const revision = hookRevisionField(body?.revision);
    const publicKey = await hookPublicKeyField(body?.publicKey);
    const keptHeaders = parseKeptHeaders(body?.keptHeaders);
    if (revision === null || publicKey === null || keptHeaders === null) {
      return json({ error: "Missing or invalid hook fields." }, 400);
    }
    const hookId = newHookId();
    const minted = this.core.mintHook({
      hookId,
      revision,
      publicKey,
      keptHeaders,
      now: Date.now(),
    });
    if (!minted.applied) {
      return json(
        { error: "A newer hook change was already applied.", code: RELAY_ERROR_STALE_REVISION },
        409,
      );
    }
    const hostId = this.core.host()!.host_id;
    const url = hookUrl(
      publicRelayOrigin(request, this.env),
      hostId,
      hookId,
      await hookMac(pathKey, hostId, hookId),
    );
    return json({ hookId, url } as RelayHookMintResult, 201);
  }

  /** `PUT /v2/hosts/{h}/hooks`: the host's whole wanted state, applied only if newer. */
  private async handleSetHooks(request: Request): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    const body = (await readJson(request)) as Record<string, unknown> | null;
    const revision = hookRevisionField(body?.revision);
    const publicKey = await hookPublicKeyField(body?.publicKey);
    const active = parseActiveHooks(body?.active);
    if (revision === null || publicKey === null || active === null) {
      return json({ error: "Missing or invalid hook fields." }, 400);
    }
    const result = this.core.setHooks({ revision, publicKey, active, now: Date.now() });
    await this.scheduleDeadlines();
    return json(result);
  }

  /** `GET /v2/hosts/{h}/hooks`: lets a host whose control socket was refused check it still exists. */
  private async handleHookStatus(request: Request): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    return json({ revision: this.core.hookRevision() } satisfies RelayHookStatusResult);
  }

  /** `GET /v2/hosts/{h}/hooks/deliveries/{id}`: a delivery too large for the control socket. */
  private async handleGetHookDelivery(request: Request, deliveryId: string): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    const delivery = this.core.hookDelivery(deliveryId);
    return delivery ? json(delivery) : json({ error: "Not found." }, 404);
  }

  private async handleCreateInvite(request: Request): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    const body = (await readJson(request)) as {
      hostLabel?: unknown;
      claimTokenHash?: unknown;
    } | null;
    // The host makes the QR secret; the relay only keeps this hash to gate claims.
    const claimTokenHash = base64UrlField(body?.claimTokenHash, 100);
    if (!claimTokenHash) return json({ error: "Missing claim token hash." }, 400);
    if (typeof body?.hostLabel === "string" && body.hostLabel.trim()) {
      this.core.setLabel(body.hostLabel.trim().slice(0, 120));
    }
    const host = this.core.host()!;
    const now = Date.now();
    const inviteId = crypto.randomUUID();
    const expiresAt = now + hostLimitsFromEnv(this.env).inviteTtlMs;

    let code: string | null = null;
    for (let attempt = 0; attempt < CODE_CLAIM_ATTEMPTS && code === null; attempt += 1) {
      const candidate = randomDigits(6);
      const claimed = await this.env.RELAY_CODE_SHARD.getByName(codeShardName(candidate)).claim({
        code: candidate,
        hostId: host.host_id,
        inviteId,
        expiresAt,
      });
      if (claimed) code = candidate;
    }
    if (code === null) {
      return json({ error: "Couldn't make a code right now. Try again." }, 503);
    }

    const outcome = this.core.createInvite({ inviteId, code, claimTokenHash, now });
    await this.applyEffects(outcome.effects);
    await this.scheduleDeadlines();
    return json(
      { inviteId, code, expiresAt: new Date(outcome.result.expiresAt).toISOString() },
      201,
    );
  }

  private async handleCancelInvite(request: Request, inviteId: string): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    const outcome = this.core.cancelInvite(inviteId, Date.now());
    await this.applyEffects(outcome.effects);
    return json({ ok: true });
  }

  private async handleClaim(request: Request, inviteId: string): Promise<Response> {
    const body = (await readJson(request)) as Record<string, unknown> | null;
    const parsed = parseJoinBody(body, "claim");
    if (!parsed?.claimProof) {
      return json({ error: "That link is incomplete.", code: "invalid-invite" }, 400);
    }
    const outcome = await this.join({
      inviteId,
      joinId: parsed.joinId,
      deviceSecretHash: parsed.deviceSecretHash,
      requestSecretHash: parsed.requestSecretHash,
      devicePublicKey: parsed.devicePublicKey,
      joiner: parsed.joiner,
      claimTokenHash: await sha256Base64Url(parsed.secret),
      claimProof: parsed.claimProof,
    });
    if (!outcome.ok) {
      return json({ error: outcome.message, code: outcome.code }, joinErrorStatus(outcome.code));
    }
    return json(outcome.result, 201);
  }

  private async requestSecretHash(request: Request, viaProtocol = false): Promise<string | null> {
    const token = viaProtocol
      ? parseRelayTokenProtocol(request.headers.get("Sec-WebSocket-Protocol")).token
      : parseBearerToken(request.headers.get("Authorization"));
    return token ? sha256Base64Url(token) : null;
  }

  private async handleRequestStatus(request: Request, requestId: string): Promise<Response> {
    const secretHash = await this.requestSecretHash(request);
    if (!secretHash) return json({ error: "Missing request secret." }, 401);
    const outcome = this.core.requestStatus({
      requestId,
      requestSecretHash: secretHash,
      now: Date.now(),
    });
    await this.applyEffects(outcome.effects);
    return json(outcome.result);
  }

  private async handleHostNonce(request: Request, requestId: string): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    const body = (await readJson(request)) as {
      hostNonce?: unknown;
      hostPublicKey?: unknown;
    } | null;
    const hostNonce = base64UrlField(body?.hostNonce, 100);
    const hostPublicKey = base64UrlField(body?.hostPublicKey, 120);
    if (!hostNonce || !hostPublicKey) return json({ error: "Missing nonce or key." }, 400);
    const outcome = this.core.setHostNonce({
      requestId,
      hostNonce,
      hostPublicKey,
      now: Date.now(),
    });
    await this.applyEffects(outcome.effects);
    return json(outcome.result);
  }

  private async handleReveal(request: Request, requestId: string): Promise<Response> {
    const secretHash = await this.requestSecretHash(request);
    if (!secretHash) return json({ error: "Missing request secret." }, 401);
    const body = (await readJson(request)) as { deviceNonce?: unknown } | null;
    const deviceNonce = base64UrlField(body?.deviceNonce, 100);
    if (!deviceNonce) return json({ error: "Missing nonce." }, 400);
    const outcome = this.core.reveal({
      requestId,
      requestSecretHash: secretHash,
      deviceNonce,
      now: Date.now(),
    });
    await this.applyEffects(outcome.effects);
    return json(outcome.result);
  }

  private async handleCancelRequest(request: Request, requestId: string): Promise<Response> {
    const secretHash = await this.requestSecretHash(request);
    if (!secretHash) return json({ error: "Missing request secret." }, 401);
    const outcome = this.core.cancelRequest({
      requestId,
      requestSecretHash: secretHash,
      now: Date.now(),
    });
    await this.applyEffects(outcome.effects);
    return json(outcome.result);
  }

  private async handleWatch(request: Request, requestId: string): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return json({ error: "Expected WebSocket upgrade." }, 400);
    const secretHash = await this.requestSecretHash(request, true);
    if (!secretHash) return json({ error: "Missing request secret." }, 401);
    const status = this.core.requestStatus({
      requestId,
      requestSecretHash: secretHash,
      now: Date.now(),
    });
    await this.applyEffects(status.effects);

    const tag = `watch:${requestId}`;
    for (const socket of this.ctx.getWebSockets(tag)) {
      socket.close(RELAY_CLOSE_CODE_REPLACED, "Replaced by a newer watcher.");
    }
    const { client, server } = this.accept(
      [tag],
      { role: "watch", connectedAt: Date.now(), requestId },
      request,
    );
    this.send(server, {
      type: "request.state",
      state: status.result.state,
      deviceId: status.result.deviceId,
    } satisfies RelayWatchEvent);
    if (status.result.hostNonce) {
      this.send(server, {
        type: "request.host-nonce",
        hostNonce: status.result.hostNonce,
      } satisfies RelayWatchEvent);
    }
    return upgradeResponse(client, request);
  }

  private async handleDecision(
    request: Request,
    requestId: string,
    action: "approve" | "deny",
  ): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    const body = (await readJson(request)) as { deviceLabel?: unknown } | null;
    const deviceLabel =
      typeof body?.deviceLabel === "string" && body.deviceLabel.trim()
        ? body.deviceLabel.trim().slice(0, 120)
        : undefined;
    const outcome = this.core.decide({
      requestId,
      decision: action,
      ...(deviceLabel ? { deviceLabel } : {}),
      now: Date.now(),
    });
    await this.applyEffects(outcome.effects);
    await this.scheduleDeadlines();
    return json(outcome.result);
  }

  private async handleRevoke(request: Request, deviceId: string): Promise<Response> {
    if (!(await this.requireHostSecret(request))) return badHostSecret();
    const outcome = this.core.revokeDevice(deviceId, Date.now());
    await this.applyEffects(outcome.effects);
    return json(outcome.result);
  }

  private async deviceState(
    request: Request,
    deviceId: string,
    viaProtocol: boolean,
  ): Promise<"active" | "revoked" | null> {
    const token = viaProtocol
      ? parseRelayTokenProtocol(request.headers.get("Sec-WebSocket-Protocol")).token
      : parseBearerToken(request.headers.get("Authorization"));
    if (!token) return null;
    return this.core.authenticateDevice(deviceId, await sha256Base64Url(token));
  }

  private async handleDeviceStatus(request: Request, deviceId: string): Promise<Response> {
    const state = await this.deviceState(request, deviceId, false);
    if (state === null) return json({ error: "Unknown device." }, 401);
    const now = Date.now();
    const usage = this.core.usage(now, this.pendingUsage());
    return json({
      hostOnline: this.isHostOnline(now),
      revoked: state === "revoked",
      limited: usage.limited,
      relayBusy: await this.isRelayBusy(now),
      ...(usage.limited ? { resetsAt: usage.resetsAt } : {}),
    } satisfies RelayDeviceStatusResult);
  }

  private async handleDeviceConnect(request: Request, deviceId: string): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return json({ error: "Expected WebSocket upgrade." }, 400);
    const state = await this.deviceState(request, deviceId, true);
    if (state === null) return json({ error: "Unknown device." }, 401);

    const now = Date.now();
    // Refusals use a plain (non-hibernatable) socket that is accepted and
    // closed at once: the close frame follows the 101, and the close code is
    // how a browser learns why (removed, over the limit, computer offline).
    const refuse = (code: number, reason: string) => {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(code, reason);
      return upgradeResponse(pair[0], request);
    };
    if (state === "revoked") return refuse(RELAY_CLOSE_CODE_ACCESS_REMOVED, "Access removed.");
    if (this.core.isLimited(now, this.pendingUsage())) {
      return refuse(RELAY_CLOSE_CODE_DAILY_LIMIT, "Daily relay allowance used.");
    }
    if (await this.isRelayBusy(now))
      return refuse(RELAY_CLOSE_CODE_RELAY_BUSY, "The relay is busy.");
    const control = this.liveControlSocket(now);
    if (!control) return refuse(RELAY_CLOSE_CODE_HOST_OFFLINE, "The computer is offline.");

    // One pending-or-open pipe per device: a newer connect replaces the older one.
    this.reservations.get(deviceId)?.settle("replaced");
    this.closeDeviceSockets(deviceId, RELAY_CLOSE_CODE_REPLACED, "Replaced by a newer connection.");

    const pipeId = crypto.randomUUID();
    const outcome = await new Promise<PipeOutcome>((resolve) => {
      const timer = setTimeout(() => settle("timeout"), PIPE_ATTACH_TIMEOUT_MS);
      const settle = (value: PipeOutcome) => {
        if (this.reservations.get(deviceId)?.pipeId === pipeId) {
          this.reservations.delete(deviceId);
        }
        clearTimeout(timer);
        resolve(value);
      };
      this.reservations.set(deviceId, { deviceId, pipeId, settle, timer });
      this.send(control, {
        type: "device.connecting",
        deviceId: deviceId as RelayDeviceId,
        pipeId: pipeId as RelayPipeId,
      } satisfies RelayControlEvent);
    });

    if (outcome !== "attached") {
      this.earlyPipeFrames.delete(pipeId);
      for (const pipe of this.socketsForPipe(pipeId, "host-pipe")) {
        pipe.close(1000, "Device connection abandoned.");
      }
      if (outcome === "revoked") return refuse(RELAY_CLOSE_CODE_ACCESS_REMOVED, "Access removed.");
      if (outcome === "replaced")
        return refuse(RELAY_CLOSE_CODE_REPLACED, "Replaced by a newer connection.");
      if (outcome === "not-yet") return refuse(RELAY_CLOSE_CODE_PEER_UNAVAILABLE, "Not ready yet.");
      return refuse(RELAY_CLOSE_CODE_HOST_OFFLINE, "The computer didn't answer.");
    }

    const { client, server } = this.accept(
      [`pipe:${pipeId}`, `device:${deviceId}`],
      { role: "device", connectedAt: Date.now(), deviceId, pipeId },
      request,
    );
    const early = this.earlyPipeFrames.get(pipeId) ?? [];
    this.earlyPipeFrames.delete(pipeId);
    for (const frame of early) {
      server.send(frame);
    }
    return upgradeResponse(client, request);
  }

  private async handlePipe(request: Request, pipeId: string): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return json({ error: "Expected WebSocket upgrade." }, 400);
    if (!(await this.requireHostSecret(request, true))) return badHostSecret();
    const reservation = [...this.reservations.values()].find((entry) => entry.pipeId === pipeId);
    if (!reservation) return json({ error: "That pipe is no longer wanted." }, 410);

    const { client } = this.accept(
      [`pipe:${pipeId}`, "host-pipe"],
      { role: "host-pipe", connectedAt: Date.now(), deviceId: reservation.deviceId, pipeId },
      request,
    );
    this.earlyPipeFrames.set(pipeId, []);
    reservation.settle("attached");
    return upgradeResponse(client, request);
  }

  // ----- socket events ---------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment) {
      ws.close(1008, "Unknown relay connection.");
      return;
    }
    const now = Date.now();

    if (attachment.role === "control") {
      const parsed = parseControlMessage(message);
      if (parsed?.type === "hook.ack") {
        // Acknowledgements have their own budget (at most one a second from
        // the host); an extra one is dropped and the deliveries come again.
        if (await this.allowHookAck()) this.handleHookAck(parsed);
        return;
      }
      // A host sends a lease a minute and the odd refusal; anything more is a flood.
      if (!(await this.allowControlMessage())) {
        ws.close(1008, "Too many control messages.");
        return;
      }
      if (parsed) this.handleControlMessage(ws, attachment, parsed, now);
      return;
    }
    if (attachment.role === "watch") {
      // Watchers only listen (their heartbeats are answered at the edge).
      ws.close(1008, "Watch connections don't send messages.");
      return;
    }

    const rateKey =
      attachment.role === "device"
        ? `device:${attachment.deviceId}`
        : `host:${this.core.host()?.host_id}`;
    if (!(await this.allowMessage(rateKey))) {
      ws.close(1013, "Relay message rate limit exceeded.");
      return;
    }

    const pipeId = attachment.pipeId;
    if (!pipeId) {
      ws.close(1008, "Missing relay pipe.");
      return;
    }

    if (attachment.role === "device" && !this.liveControlSocket(now)) {
      this.closePipe(pipeId, RELAY_CLOSE_CODE_HOST_OFFLINE, "The computer went offline.");
      return;
    }
    this.tallyForwarded(ws, attachment, now);
    if (this.core.isLimited(now, this.pendingUsage())) {
      this.commitPendingUsage(now);
      this.closePipe(pipeId, RELAY_CLOSE_CODE_DAILY_LIMIT, "Daily relay allowance used.");
      this.notifyUsage(now);
      return;
    }
    // Open connections stop at the relay-wide budget too, not only new ones.
    if (this.knownRelayBusy(now)) {
      this.commitPendingUsage(now);
      this.closePipe(pipeId, RELAY_CLOSE_CODE_RELAY_BUSY, "The relay is busy.");
      return;
    }

    const partnerRole: SocketRole = attachment.role === "device" ? "host-pipe" : "device";
    const [partner] = this.socketsForPipe(pipeId, partnerRole);
    if (partner) {
      partner.send(message);
    } else if (attachment.role === "host-pipe") {
      // The device side is still being accepted; hold a few frames for it.
      const early = this.earlyPipeFrames.get(pipeId);
      if (early && early.length < MAX_BUFFERED_PIPE_FRAMES) early.push(message);
    } else {
      ws.close(RELAY_CLOSE_CODE_PEER_UNAVAILABLE, "The computer's end of this connection closed.");
    }
  }

  private handleHookAck(parsed: ControlMessage): void {
    const ids = parsed.deliveryIds;
    if (!Array.isArray(ids) || ids.length > 100) return;
    this.core.ackHookDeliveries(
      ids.filter((id): id is string => typeof id === "string" && id.length <= 100),
    );
  }

  private handleControlMessage(
    ws: WebSocket,
    attachment: SocketAttachment,
    parsed: ControlMessage,
    now: number,
  ): void {
    if (parsed.type === "lease") {
      // Re-read: the copy passed in predates awaits, and writing it back would
      // undo anything saved since (like the ledger's latest answer).
      const current = readAttachment(ws) ?? attachment;
      ws.serializeAttachment({ ...current, leaseAt: now } satisfies SocketAttachment);
      if (typeof parsed.hostLabel === "string" && parsed.hostLabel.trim()) {
        this.core.setLabel(parsed.hostLabel.trim().slice(0, 120));
      }
      const lastCommitAt = readAttachment(ws)?.lastCommitAt ?? 0;
      if (now - lastCommitAt >= USAGE_COMMIT_INTERVAL_MS && this.commitPendingUsage(now)) {
        this.notifyUsage(now);
      }
      return;
    }
    if (parsed.type === "pipe.refuse" && typeof parsed.pipeId === "string") {
      const reservation = [...this.reservations.values()].find(
        (entry) => entry.pipeId === parsed.pipeId,
      );
      reservation?.settle(parsed.reason === "revoked" ? "revoked" : "not-yet");
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.handleSocketGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // A dropped connection reports 1005/1006, which can't be sent back.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.handleSocketGone(ws);
  }

  private handleSocketGone(ws: WebSocket): void {
    const attachment = readAttachment(ws);
    if (!attachment) return;
    if (attachment.role === "device" && (attachment.pendingMessages ?? 0) > 0) {
      // This socket's tally would vanish with it; commit it now.
      const now = Date.now();
      this.core.commitUsage(now, { messages: attachment.pendingMessages ?? 0, awakeSeconds: 0 });
      ws.serializeAttachment({ ...attachment, pendingMessages: 0 } satisfies SocketAttachment);
      this.ctx.waitUntil(this.reportToLedger(attachment.pendingMessages ?? 0));
    }
    if (attachment.role === "device" && attachment.pipeId) {
      for (const pipe of this.socketsForPipe(attachment.pipeId, "host-pipe")) {
        pipe.close(1000, "Device disconnected.");
      }
    } else if (attachment.role === "host-pipe" && attachment.pipeId) {
      this.earlyPipeFrames.delete(attachment.pipeId);
      for (const device of this.socketsForPipe(attachment.pipeId, "device")) {
        device.close(
          RELAY_CLOSE_CODE_PEER_UNAVAILABLE,
          "The computer's end of this connection closed.",
        );
      }
    } else if (attachment.role === "control") {
      // A replaced control socket can close after its successor has taken
      // device connections; only the last one going means the host is gone.
      const successor = this.ctx
        .getWebSockets("control")
        .some((socket) => socket !== ws && socket.readyState === WebSocket.OPEN);
      if (!successor) {
        for (const reservation of this.reservations.values()) {
          reservation.settle("host-offline");
        }
      }
    }
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    await this.applyEffects(this.core.expireDue(now));
    await this.scheduleDeadlines();
  }

  // ----- helpers ---------------------------------------------------------------

  private accept(
    tags: ReadonlyArray<string>,
    attachment: SocketAttachment,
    _request: Request,
  ): { readonly client: WebSocket; readonly server: WebSocket } {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [...tags]);
    return { client, server };
  }

  private liveControlSocket(now: number): WebSocket | null {
    for (const socket of this.ctx.getWebSockets("control")) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const leaseAt = readAttachment(socket)?.leaseAt ?? 0;
      if (now - leaseAt <= HOST_LEASE_MS) return socket;
      // The host stopped renewing: treat it as gone and drop its pipes too.
      socket.close(RELAY_CLOSE_CODE_HOST_OFFLINE, "Host lease lapsed.");
      for (const pipe of this.ctx.getWebSockets("host-pipe")) {
        const pipeId = readAttachment(pipe)?.pipeId;
        if (pipeId)
          this.closePipe(pipeId, RELAY_CLOSE_CODE_HOST_OFFLINE, "The computer went offline.");
      }
    }
    return null;
  }

  private isHostOnline(now: number): boolean {
    return this.liveControlSocket(now) !== null;
  }

  private socketsForPipe(pipeId: string, role: SocketRole): WebSocket[] {
    return this.ctx
      .getWebSockets(`pipe:${pipeId}`)
      .filter((socket) => readAttachment(socket)?.role === role);
  }

  private closePipe(pipeId: string, code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets(`pipe:${pipeId}`)) {
      const role = readAttachment(socket)?.role;
      socket.close(role === "device" ? code : 1000, reason);
    }
  }

  private closeDeviceSockets(deviceId: string, code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets(`device:${deviceId}`)) {
      const pipeId = readAttachment(socket)?.pipeId;
      socket.close(code, reason);
      if (pipeId) {
        for (const pipe of this.socketsForPipe(pipeId, "host-pipe")) {
          pipe.close(1000, reason);
        }
      }
    }
  }

  private async applyEffects(effects: ReadonlyArray<HostEffect>): Promise<void> {
    const host = this.core.host();
    for (const effect of effects) {
      switch (effect.type) {
        case "watch":
          for (const socket of this.ctx.getWebSockets(`watch:${effect.requestId}`)) {
            this.send(socket, effect.event);
          }
          break;
        case "control":
          for (const socket of this.ctx.getWebSockets("control")) {
            this.send(socket, effect.event);
          }
          break;
        case "release-code":
          if (host) {
            this.ctx.waitUntil(
              this.env.RELAY_CODE_SHARD.getByName(codeShardName(effect.code)).release({
                code: effect.code,
                hostId: host.host_id,
                inviteId: effect.inviteId,
              }),
            );
          }
          break;
        case "close-device":
          this.reservations.get(effect.deviceId)?.settle("revoked");
          this.closeDeviceSockets(effect.deviceId, effect.code, effect.reason);
          break;
      }
    }
  }

  /** Counts one forwarded frame on its device socket and, per 10 s window, on the control socket. */
  private tallyForwarded(ws: WebSocket, attachment: SocketAttachment, now: number): void {
    const deviceSocket =
      attachment.role === "device"
        ? ws
        : attachment.pipeId
          ? this.socketsForPipe(attachment.pipeId, "device")[0]
          : undefined;
    if (deviceSocket) {
      const deviceAttachment = readAttachment(deviceSocket);
      if (deviceAttachment) {
        deviceSocket.serializeAttachment({
          ...deviceAttachment,
          pendingMessages: (deviceAttachment.pendingMessages ?? 0) + 1,
        } satisfies SocketAttachment);
      }
    }
    const window = Math.floor(now / AWAKE_WINDOW_MS);
    for (const control of this.ctx.getWebSockets("control")) {
      const controlAttachment = readAttachment(control);
      if (!controlAttachment || controlAttachment.lastAwakeWindow === window) continue;
      control.serializeAttachment({
        ...controlAttachment,
        lastAwakeWindow: window,
        pendingAwakeSeconds: (controlAttachment.pendingAwakeSeconds ?? 0) + AWAKE_WINDOW_MS / 1000,
      } satisfies SocketAttachment);
    }
  }

  /** Usage held on live sockets and not yet committed. */
  private pendingUsage(): PendingUsage {
    let messages = 0;
    let awakeSeconds = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment?.role === "device") messages += attachment.pendingMessages ?? 0;
      if (attachment?.role === "control") awakeSeconds += attachment.pendingAwakeSeconds ?? 0;
    }
    return { messages, awakeSeconds };
  }

  /** Moves socket tallies into storage (one row write) and reports them to the ledger. */
  private commitPendingUsage(now: number): boolean {
    const pending = this.pendingUsage();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment?.role === "device" && (attachment.pendingMessages ?? 0) > 0) {
        socket.serializeAttachment({
          ...attachment,
          pendingMessages: 0,
        } satisfies SocketAttachment);
      }
      if (attachment?.role === "control") {
        socket.serializeAttachment({
          ...attachment,
          pendingAwakeSeconds: 0,
          lastCommitAt: now,
        } satisfies SocketAttachment);
      }
    }
    if (pending.messages === 0 && pending.awakeSeconds === 0) return false;
    this.core.commitUsage(now, pending);
    if (pending.messages > 0) this.ctx.waitUntil(this.reportToLedger(pending.messages));
    return true;
  }

  private notifyUsage(now: number): void {
    const event: RelayControlEvent = {
      type: "usage",
      usage: this.core.usage(now, this.pendingUsage()),
    };
    for (const socket of this.ctx.getWebSockets("control")) {
      this.send(socket, event);
    }
  }

  private async scheduleDeadlines(): Promise<void> {
    const next = this.core.nextDeadline();
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * The last known relay-wide answer, refreshed in the background. Forwarding
   * must not wait on the ledger: awaiting another object lets later frames
   * overtake this one.
   */
  private knownRelayBusy(now: number): boolean {
    this.restoreLedgerAnswer();
    if (now - this.ledgerCheckedAt >= LEDGER_BUSY_CACHE_MS && !this.ledgerRefreshing) {
      this.ledgerRefreshing = true;
      this.ctx.waitUntil(
        this.isRelayBusy(now).finally(() => {
          this.ledgerRefreshing = false;
        }),
      );
    }
    return this.ledgerBusy;
  }

  private async isRelayBusy(now: number): Promise<boolean> {
    this.restoreLedgerAnswer();
    if (now - this.ledgerCheckedAt < LEDGER_BUSY_CACHE_MS) return this.ledgerBusy;
    let busy: boolean;
    try {
      busy = await this.env.RELAY_LEDGER.getByName(RELAY_LEDGER_NAME).isBusy();
    } catch {
      // A ledger hiccup must not take devices offline.
      busy = false;
    }
    this.rememberLedgerAnswer(busy, now);
    return busy;
  }

  /** Picks up the last answer from the control socket after hibernation wiped memory. */
  private restoreLedgerAnswer(): void {
    if (this.ledgerCheckedAt !== 0) return;
    for (const socket of this.ctx.getWebSockets("control")) {
      const attachment = readAttachment(socket);
      if (attachment?.ledgerCheckedAt) {
        this.ledgerBusy = attachment.ledgerBusy ?? false;
        this.ledgerCheckedAt = attachment.ledgerCheckedAt;
        return;
      }
    }
  }

  /**
   * Keeps the ledger's answer where hibernation won't lose it, and when the
   * relay just turned busy, ends the data connections already open.
   */
  private rememberLedgerAnswer(busy: boolean, checkedAt: number): void {
    const turnedBusy = busy && !this.ledgerBusy;
    this.ledgerBusy = busy;
    this.ledgerCheckedAt = checkedAt;
    for (const socket of this.ctx.getWebSockets("control")) {
      const attachment = readAttachment(socket);
      if (attachment) {
        socket.serializeAttachment({
          ...attachment,
          ledgerBusy: busy,
          ledgerCheckedAt: checkedAt,
        } satisfies SocketAttachment);
      }
    }
    if (turnedBusy) {
      for (const socket of this.ctx.getWebSockets()) {
        const pipeId =
          readAttachment(socket)?.role === "device" ? readAttachment(socket)?.pipeId : null;
        if (pipeId) this.closePipe(pipeId, RELAY_CLOSE_CODE_RELAY_BUSY, "The relay is busy.");
      }
    }
  }

  private async reportToLedger(messages: number): Promise<void> {
    try {
      const { busy } = await this.env.RELAY_LEDGER.getByName(RELAY_LEDGER_NAME).report(messages);
      this.rememberLedgerAnswer(busy, Date.now());
    } catch (error) {
      log("warn", "relay ledger report failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async allowControlMessage(): Promise<boolean> {
    try {
      return (
        await this.env.CONTROL_RATE_LIMITER.limit({ key: `control:${this.core.host()?.host_id}` })
      ).success;
    } catch {
      return true;
    }
  }

  private async allowHookAck(): Promise<boolean> {
    try {
      return (
        await this.env.HOOK_ACK_RATE_LIMITER.limit({ key: `hooks:${this.core.host()?.host_id}` })
      ).success;
    } catch {
      return true;
    }
  }

  private async allowMessage(key: string): Promise<boolean> {
    try {
      return (await this.env.RELAY_MESSAGE_RATE_LIMITER.limit({ key })).success;
    } catch {
      return true;
    }
  }

  private send(ws: WebSocket, event: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const role = readAttachment(ws)?.role;
    // Raw data sockets only ever carry app frames or prefixed control frames.
    const prefix = role === "device" || role === "host-pipe" ? RELAY_RAW_CONTROL_PREFIX : "";
    ws.send(`${prefix}${JSON.stringify(event)}`);
  }
}

interface ControlMessage {
  readonly type?: unknown;
  readonly hostLabel?: unknown;
  readonly pipeId?: unknown;
  readonly reason?: unknown;
  readonly deliveryIds?: unknown;
}

function parseControlMessage(message: string | ArrayBuffer): ControlMessage | null {
  if (typeof message !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === "object" && parsed !== null ? (parsed as ControlMessage) : null;
  } catch {
    return null;
  }
}

function badHostSecret(): Response {
  return json({ error: "Invalid host secret.", code: RELAY_ERROR_BAD_HOST_SECRET }, 401);
}

function hookRefusal(refusal: Extract<HookAdmission, { ok: false }>): HookDeliveryOutcome {
  return refusal.status === 404
    ? { status: 404 }
    : {
        status: 429,
        reason: refusal.reason === "daily-limit" ? "daily-limit" : "queue-full",
        retryAfterSeconds: refusal.retryAfterSeconds ?? 60,
      };
}

function hookRevisionField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** A P-256 public key (raw point, base64url) that actually imports. */
async function hookPublicKeyField(value: unknown): Promise<string | null> {
  const text = base64UrlField(value, 200);
  return text && (await decodePublicKey(text)) ? text : null;
}

function parseActiveHooks(
  value: unknown,
): Array<{ readonly hookId: string; readonly keptHeaders: string[] }> | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const hooks: Array<{ readonly hookId: string; readonly keptHeaders: string[] }> = [];
  for (const item of value) {
    const entry = item as { hookId?: unknown; keptHeaders?: unknown } | null;
    const keptHeaders = parseKeptHeaders(entry?.keptHeaders);
    if (!isHookId(entry?.hookId) || keptHeaders === null) return null;
    hooks.push({ hookId: entry.hookId, keptHeaders });
  }
  return hooks;
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    return (ws.deserializeAttachment() as SocketAttachment | undefined) ?? null;
  } catch {
    return null;
  }
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function upgradeResponse(client: WebSocket, request: Request): Response {
  const { selectedProtocol } = parseRelayTokenProtocol(
    request.headers.get("Sec-WebSocket-Protocol"),
  );
  const headers = new Headers();
  if (selectedProtocol) {
    headers.set("Sec-WebSocket-Protocol", RELAY_WEBSOCKET_PROTOCOL);
  }
  return new Response(null, { status: 101, webSocket: client, headers });
}

function json(body: unknown, status = 200): Response {
  return createJsonResponse(body, { status });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
