import { DurableObject } from "cloudflare:workers";

import type {
  RelayConnectionId,
  RelayConnectionRole,
  RelayForwardedEvent,
  RelayPeerJoinedEvent,
  RelayPeerLeftEvent,
  RelayPeerSummary,
  RelayReadyEvent,
} from "@t3tools/contracts/relay";
import {
  createJsonResponse,
  isRelayConnectionRole,
  parseRelayClientMessage,
  parseRelayTokenProtocol,
  RELAY_WEBSOCKET_PROTOCOL,
} from "./protocol.ts";

interface StoredSessionRow extends Record<string, SqlStorageValue> {
  readonly session_id: string;
  readonly desktop_token_hash: string;
  readonly device_token_hash: string;
  readonly created_at: number;
  readonly expires_at: number;
}

interface InitializeRelaySessionInput {
  readonly sessionId: string;
  readonly desktopTokenHash: string;
  readonly deviceTokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface SocketAttachment {
  readonly role: RelayConnectionRole;
  readonly connectionId: string;
  readonly connectedAt: number;
  readonly mode: "envelope" | "raw";
}

const DEFAULT_APP_ORIGIN = "https://app.threadlines.dev";
const DEFAULT_ALLOWED_ORIGINS = [
  DEFAULT_APP_ORIGIN,
  "http://localhost:5733",
  "http://127.0.0.1:5733",
];
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_CREATE_SESSION_BODY_BYTES = 4096;

export class RelaySession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS relay_sessions (
          session_id TEXT PRIMARY KEY,
          desktop_token_hash TEXT NOT NULL,
          device_token_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
    });
  }

  async initialize(input: InitializeRelaySessionInput): Promise<void> {
    const existing = this.readSession();
    if (existing) {
      throw new Error("Relay session already exists.");
    }

    this.ctx.storage.sql.exec(
      `
        INSERT INTO relay_sessions (
          session_id,
          desktop_token_hash,
          device_token_hash,
          created_at,
          expires_at
        )
        VALUES (?, ?, ?, ?, ?)
      `,
      input.sessionId,
      input.desktopTokenHash,
      input.deviceTokenHash,
      input.createdAt,
      input.expiresAt,
    );
    await this.ctx.storage.setAlarm(input.expiresAt);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return createJsonResponse({ error: "Expected WebSocket upgrade." }, { status: 400 });
    }

    if (!isAllowedOrigin(request, this.env)) {
      return createJsonResponse({ error: "Origin is not allowed." }, { status: 403 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (!isRelayConnectionRole(role)) {
      return createJsonResponse({ error: "Missing or invalid relay role." }, { status: 400 });
    }

    const token = readConnectionToken(request, url);
    if (!token) {
      return createJsonResponse({ error: "Missing relay token." }, { status: 401 });
    }

    const session = this.readSession();
    if (!session) {
      return createJsonResponse({ error: "Relay session was not found." }, { status: 404 });
    }

    if (session.expires_at <= Date.now()) {
      await this.expireSession("session-expired");
      return createJsonResponse({ error: "Relay session expired." }, { status: 410 });
    }

    const tokenHash = await sha256Base64Url(token);
    const expectedHash =
      role === "desktop" ? session.desktop_token_hash : session.device_token_hash;
    if (tokenHash !== expectedHash) {
      return createJsonResponse({ error: "Invalid relay token." }, { status: 401 });
    }

    if (role === "desktop" && this.hasConnectedDesktop()) {
      return createJsonResponse({ error: "A desktop is already connected." }, { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const mode = url.searchParams.get("mode") === "raw" ? "raw" : "envelope";
    const attachment: SocketAttachment = {
      role,
      connectionId: crypto.randomUUID(),
      connectedAt: Date.now(),
      mode,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    if (mode === "envelope") {
      this.sendJson(server, {
        version: 1,
        type: "relay.ready",
        sessionId: session.session_id as RelayReadyEvent["sessionId"],
        connectionId: attachment.connectionId as RelayConnectionId,
        role,
        peers: this.getPeerSummary(),
      } satisfies RelayReadyEvent);
      this.broadcastPeerJoined(attachment, server);
    }

    const { selectedProtocol } = parseRelayTokenProtocol(
      request.headers.get("Sec-WebSocket-Protocol"),
    );
    const headers = new Headers();
    if (selectedProtocol) {
      headers.set("Sec-WebSocket-Protocol", RELAY_WEBSOCKET_PROTOCOL);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers,
    });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readSocketAttachment(ws);
    if (!attachment) {
      this.sendError(ws, "not-authenticated", "This device is not connected to the relay.");
      ws.close(1008, "Missing relay connection.");
      return;
    }

    if (typeof message !== "string") {
      if (attachment.mode === "raw") {
        this.forwardRawMessage(ws, attachment, message);
        return;
      }
      this.sendError(ws, "bad-message", "Relay messages must be JSON text.");
      return;
    }

    if (attachment.mode === "raw") {
      this.forwardRawMessage(ws, attachment, message);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.sendError(ws, "bad-message", "Relay message was not valid JSON.");
      return;
    }

    const clientMessage = parseRelayClientMessage(parsed);
    if (!clientMessage) {
      this.sendError(ws, "bad-message", "Relay message shape was not recognized.");
      return;
    }

    if (clientMessage.type === "relay.ping") {
      this.sendJson(ws, { version: 1, type: "relay.pong" });
      return;
    }

    const recipients = this.getRecipients(ws, attachment.role, clientMessage.target);
    if (recipients.length === 0) {
      this.sendError(ws, "peer-unavailable", "The other device is not connected.");
      return;
    }

    const forwarded: RelayForwardedEvent = {
      version: 1,
      type: "relay.forwarded",
      from: attachment.role,
      connectionId: attachment.connectionId as RelayConnectionId,
      payload: clientMessage.payload,
    };
    for (const recipient of recipients) {
      this.sendJson(recipient, forwarded);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = readSocketAttachment(ws);
    if (attachment?.mode === "envelope") {
      this.broadcastPeerLeft(attachment, ws);
    }
    ws.close(code, reason);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = readSocketAttachment(ws);
    log("warn", "relay websocket error", {
      connectionId: attachment?.connectionId,
      role: attachment?.role,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  override async alarm(): Promise<void> {
    await this.expireSession("session-expired");
  }

  private readSession(): StoredSessionRow | null {
    return (
      this.ctx.storage.sql
        .exec<StoredSessionRow>(
          `
            SELECT
              session_id,
              desktop_token_hash,
              device_token_hash,
              created_at,
              expires_at
            FROM relay_sessions
            LIMIT 1
          `,
        )
        .toArray()[0] ?? null
    );
  }

  private hasConnectedDesktop(): boolean {
    return this.ctx
      .getWebSockets()
      .some((socket) => readSocketAttachment(socket)?.role === "desktop");
  }

  private getPeerSummary(): RelayPeerSummary {
    let desktopConnected = false;
    let deviceCount = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readSocketAttachment(socket);
      if (!attachment) continue;
      if (attachment.role === "desktop") {
        desktopConnected = true;
      } else {
        deviceCount += 1;
      }
    }
    return { desktopConnected, deviceCount };
  }

  private getRecipients(
    sender: WebSocket,
    senderRole: RelayConnectionRole,
    target: "desktop" | "devices",
  ): ReadonlyArray<WebSocket> {
    const recipients: WebSocket[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === sender || socket.readyState !== WebSocket.OPEN) continue;
      const attachment = readSocketAttachment(socket);
      if (!attachment) continue;
      if (target === "desktop" && attachment.role === "desktop" && senderRole === "device") {
        recipients.push(socket);
      }
      if (target === "devices" && attachment.role === "device" && senderRole === "desktop") {
        recipients.push(socket);
      }
    }
    return recipients;
  }

  private forwardRawMessage(
    sender: WebSocket,
    attachment: SocketAttachment,
    message: string | ArrayBuffer,
  ): void {
    const target = attachment.role === "device" ? "desktop" : "devices";
    const recipients = this.getRecipients(sender, attachment.role, target);
    if (recipients.length === 0) {
      sender.close(1013, "Relay peer unavailable.");
      return;
    }

    for (const recipient of recipients) {
      recipient.send(message);
    }
  }

  private broadcastPeerJoined(attachment: SocketAttachment, except: WebSocket): void {
    this.broadcastExcept(except, {
      version: 1,
      type: "relay.peer-joined",
      role: attachment.role,
      connectionId: attachment.connectionId as RelayConnectionId,
      peers: this.getPeerSummary(),
    } satisfies RelayPeerJoinedEvent);
  }

  private broadcastPeerLeft(attachment: SocketAttachment, except: WebSocket): void {
    this.broadcastExcept(except, {
      version: 1,
      type: "relay.peer-left",
      role: attachment.role,
      connectionId: attachment.connectionId as RelayConnectionId,
      peers: this.getPeerSummary(),
    } satisfies RelayPeerLeftEvent);
  }

  private broadcastExcept(except: WebSocket, event: unknown): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except || socket.readyState !== WebSocket.OPEN) continue;
      this.sendJson(socket, event);
    }
  }

  private sendError(
    ws: WebSocket,
    code: "bad-message" | "not-authenticated" | "peer-unavailable" | "session-expired",
    message: string,
  ): void {
    this.sendJson(ws, {
      version: 1,
      type: "relay.error",
      code,
      message,
    });
  }

  private sendJson(ws: WebSocket, event: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(event));
  }

  private async expireSession(reason: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      this.sendError(socket, "session-expired", "This relay session has expired.");
      socket.close(4000, reason);
    }
    this.ctx.storage.sql.exec("DELETE FROM relay_sessions");
    await this.ctx.storage.deleteAlarm();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return withCors(
          request,
          env,
          createJsonResponse({
            ok: true,
            service: "threadlines-relay",
          }),
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        return withCors(request, env, await createRelaySession(request, env));
      }

      const connectMatch = /^\/v1\/sessions\/([^/]+)\/connect$/u.exec(url.pathname);
      if (connectMatch) {
        const sessionId = connectMatch[1];
        if (!sessionId) {
          return createJsonResponse({ error: "Missing relay session." }, { status: 400 });
        }
        const stub = env.RELAY_SESSION.getByName(sessionId);
        return stub.fetch(request);
      }

      return withCors(request, env, createJsonResponse({ error: "Not found." }, { status: 404 }));
    } catch (error) {
      log("error", "relay request failed", {
        path: url.pathname,
        method: request.method,
        error: error instanceof Error ? error.message : String(error),
      });
      return withCors(
        request,
        env,
        createJsonResponse({ error: "Relay request failed." }, { status: 500 }),
      );
    }
  },
};

async function createRelaySession(request: Request, env: Env): Promise<Response> {
  await readSmallJsonObject(request);

  const createdAt = Date.now();
  const expiresAt = createdAt + resolveSessionTtlSeconds(env) * 1000;
  const sessionId = crypto.randomUUID();
  const desktopToken = generateToken();
  const deviceToken = generateToken();
  const publicRelayOrigin = resolvePublicRelayOrigin(request, env);
  const stub = env.RELAY_SESSION.getByName(sessionId);

  await stub.initialize({
    sessionId,
    desktopTokenHash: await sha256Base64Url(desktopToken),
    deviceTokenHash: await sha256Base64Url(deviceToken),
    createdAt,
    expiresAt,
  });

  const desktopSocketUrl = buildSocketUrl(publicRelayOrigin, sessionId, "desktop");
  const deviceSocketUrl = buildSocketUrl(publicRelayOrigin, sessionId, "device");
  const pairingUrl = buildPairingUrl(
    resolveAppOrigin(env),
    publicRelayOrigin,
    sessionId,
    deviceToken,
  );

  return createJsonResponse(
    {
      sessionId,
      desktopToken,
      deviceToken,
      expiresAt: new Date(expiresAt).toISOString(),
      desktopSocketUrl,
      deviceSocketUrl,
      pairingUrl,
    },
    { status: 201 },
  );
}

async function readSmallJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_CREATE_SESSION_BODY_BYTES) {
    throw new Error("Request body is too large.");
  }

  const text = await request.text();
  if (text.length > MAX_CREATE_SESSION_BODY_BYTES) {
    throw new Error("Request body is too large.");
  }
  if (text.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function readConnectionToken(request: Request, url: URL): string | null {
  const protocolToken = parseRelayTokenProtocol(
    request.headers.get("Sec-WebSocket-Protocol"),
  ).token;
  return protocolToken ?? url.searchParams.get("token");
}

function readSocketAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    const value = ws.deserializeAttachment() as SocketAttachment | undefined;
    return value ?? null;
  } catch {
    return null;
  }
}

function buildSocketUrl(
  publicRelayOrigin: string,
  sessionId: string,
  role: RelayConnectionRole,
): string {
  const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/connect`, publicRelayOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", role);
  return url.toString();
}

function buildPairingUrl(
  appOrigin: string,
  relayOrigin: string,
  sessionId: string,
  deviceToken: string,
): string {
  const url = new URL("/pair", appOrigin);
  url.searchParams.set("relay", relayOrigin);
  url.searchParams.set("session", sessionId);
  url.hash = `token=${encodeURIComponent(deviceToken)}`;
  return url.toString();
}

function resolvePublicRelayOrigin(request: Request, env: Env): string {
  return env.THREADLINES_RELAY_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
}

function resolveAppOrigin(env: Env): string {
  return env.THREADLINES_APP_ORIGIN?.trim() || DEFAULT_APP_ORIGIN;
}

function resolveAllowedOrigins(env: Env): ReadonlySet<string> {
  const configured = env.THREADLINES_ALLOWED_ORIGINS?.trim();
  const origins = configured
    ? configured
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;
  return new Set(origins);
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return true;
  }
  return resolveAllowedOrigins(env).has(origin);
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (origin && resolveAllowedOrigins(env).has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return headers;
}

function withCors(request: Request, env: Env, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(request, env)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveSessionTtlSeconds(env: Env): number {
  const value = Number(env.THREADLINES_RELAY_SESSION_TTL_SECONDS ?? DEFAULT_SESSION_TTL_SECONDS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }
  return Math.min(Math.floor(value), MAX_SESSION_TTL_SECONDS);
}

function generateToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...data,
    }),
  );
}
