/**
 * The host side of an MCP app card's bridge (docs/mcp-apps.md): JSON-RPC 2.0
 * over postMessage with the card's view, as the MCP Apps spec lays it out
 * (https://github.com/modelcontextprotocol/ext-apps, 2026-01-26).
 *
 * One host per window the view runs in: a frame that loads again (moved
 * where a browser cannot keep it running, or reloaded) gets a new host, and
 * the view initializes again. The card (McpAppCard) owns the frame and
 * decides what each request may do; this module only speaks the protocol.
 *
 * Lifecycle: the view asks `ui/initialize`, the host answers with its
 * capabilities and context, the view says `initialized`, and the host sends
 * the call's input and then its result (`tool-cancelled` when the call ended
 * without one). Before the frame goes, the host asks `ui/resource-teardown`
 * and waits a moment for the answer.
 */
import type { McpAppToolResult } from "@threadlines/contracts";
import {
  MCP_APP_METHODS,
  MCP_APP_PROTOCOL_VERSION,
  type McpAppCsp,
  type McpAppJsonRpcId,
  type McpAppPermissions,
  readMcpAppHeight,
  readMcpAppLink,
  readMcpAppMessage,
  readMcpAppMessageText,
} from "@threadlines/shared/mcpApps";

export type McpAppDisplayMode = "inline" | "fullscreen";

/** What the card does for the view's requests. A rejected promise answers
 *  the view with an error carrying its message. */
export interface McpAppHostHandlers {
  readonly callTool: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<McpAppToolResult>;
  /** Whether the link was opened. `clicked`: the reader clicked a plain
   *  link in the view (the view's bootstrap reports those). */
  readonly openLink: (url: string, clicked: boolean) => boolean;
  /** Whether the text reached the composer. */
  readonly putMessage: (text: string) => boolean;
  readonly requestDisplayMode: (mode: string) => McpAppDisplayMode;
  readonly sizeChanged: (height: number) => void;
  readonly requestTeardown: () => void;
  /** The view's document is going away: it navigated itself. */
  readonly viewLeft: () => void;
}

export interface McpAppHostOptions {
  /** The frame's window, to post into. */
  readonly target: Window;
  readonly toolCallId: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Null: the call ended without a result. */
  readonly result: McpAppToolResult | null;
  readonly csp: McpAppCsp;
  readonly permissions: McpAppPermissions;
  /** The host context as it is now (theme, display mode, sizes). */
  readonly context: () => Record<string, unknown>;
  readonly handlers: McpAppHostHandlers;
}

/** JSON-RPC error codes the host answers with. */
const METHOD_NOT_FOUND = -32601;
const REQUEST_FAILED = -32000;

const HOST_INFO = { name: "Threadlines", version: "1" } as const;

export class McpAppHost {
  private readonly options: McpAppHostOptions;
  private initialized = false;
  private disposed = false;
  private nextId = 0;
  private readonly pending = new Map<McpAppJsonRpcId, (ok: boolean) => void>();

  constructor(options: McpAppHostOptions) {
    this.options = options;
  }

  /** The window this host speaks to. */
  get target(): Window {
    return this.options.target;
  }

  /** Handle a message the view posted (the card checks it came from the
   *  frame's window). */
  handle(data: unknown): void {
    if (this.disposed) return;
    const message = readMcpAppMessage(data);
    if (message === undefined) return;
    if (message.kind === "response") {
      const settle = this.pending.get(message.id);
      this.pending.delete(message.id);
      settle?.(message.error === undefined);
      return;
    }
    if (message.kind === "notification") {
      this.handleNotification(message.method, message.params);
      return;
    }
    void this.handleRequest(message.id, message.method, message.params);
  }

  /** Tell the view part of the host context changed (theme, display mode). */
  notifyContext(partial: Record<string, unknown>): void {
    if (!this.initialized) return;
    this.post({ jsonrpc: "2.0", method: MCP_APP_METHODS.hostContextChanged, params: partial });
  }

  /** Ask the view to clean up before its frame goes, waiting at most
   *  `timeoutMs` for its answer. */
  teardown(timeoutMs: number): Promise<void> {
    if (this.disposed || !this.initialized) return Promise.resolve();
    const id = `tl-teardown-${++this.nextId}`;
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve();
      }, timeoutMs);
      this.pending.set(id, () => {
        window.clearTimeout(timer);
        resolve();
      });
      this.post({ jsonrpc: "2.0", id, method: MCP_APP_METHODS.resourceTeardown, params: {} });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const settle of this.pending.values()) settle(false);
    this.pending.clear();
  }

  private post(message: unknown): void {
    if (this.disposed) return;
    // The view's origin is opaque: "*" is the only target that reaches it.
    this.options.target.postMessage(message, "*");
  }

  private reply(id: McpAppJsonRpcId, result: unknown): void {
    this.post({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: McpAppJsonRpcId, code: number, message: string): void {
    this.post({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const { handlers } = this.options;
    switch (method) {
      case MCP_APP_METHODS.initialized:
        this.sendCall();
        return;
      case MCP_APP_METHODS.sizeChanged: {
        const height = readMcpAppHeight(params);
        if (height !== undefined) handlers.sizeChanged(height);
        return;
      }
      case MCP_APP_METHODS.requestTeardown:
        handlers.requestTeardown();
        return;
      case MCP_APP_METHODS.linkClicked: {
        const url = readMcpAppLink(params);
        if (url !== undefined) handlers.openLink(url, true);
        return;
      }
      case MCP_APP_METHODS.viewLeft:
        handlers.viewLeft();
        return;
      default:
        // Logging and anything newer: nothing to do.
        return;
    }
  }

  private async handleRequest(
    id: McpAppJsonRpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const { handlers } = this.options;
    switch (method) {
      case MCP_APP_METHODS.initialize:
        this.initialized = true;
        this.reply(id, {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: HOST_INFO,
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            logging: {},
            message: { text: {} },
            // What the frame really has (mcpAppFrameAllow), in the spec's form.
            sandbox: {
              csp: this.options.csp,
              permissions: this.options.permissions.clipboardWrite ? { clipboardWrite: {} } : {},
            },
          },
          hostContext: {
            ...this.options.context(),
            toolInfo: {
              id: this.options.toolCallId,
              tool: { name: this.options.tool, inputSchema: { type: "object" } },
            },
          },
        });
        return;
      case MCP_APP_METHODS.ping:
        this.reply(id, {});
        return;
      case MCP_APP_METHODS.toolsCall: {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (name.length === 0) {
          this.replyError(id, REQUEST_FAILED, "A tool call needs a tool name.");
          return;
        }
        const args =
          params.arguments !== null &&
          typeof params.arguments === "object" &&
          !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        try {
          this.reply(id, await handlers.callTool(name, args));
        } catch (error) {
          this.replyError(
            id,
            REQUEST_FAILED,
            error instanceof Error && error.message ? error.message : "The tool call failed.",
          );
        }
        return;
      }
      case MCP_APP_METHODS.openLink: {
        const url = readMcpAppLink(params);
        const opened = url !== undefined && handlers.openLink(url, false);
        this.reply(id, opened ? {} : { isError: true });
        return;
      }
      case MCP_APP_METHODS.message: {
        const text = readMcpAppMessageText(params);
        const delivered = text !== undefined && handlers.putMessage(text);
        this.reply(id, delivered ? {} : { isError: true });
        return;
      }
      case MCP_APP_METHODS.requestDisplayMode:
        this.reply(id, { mode: handlers.requestDisplayMode(String(params.mode ?? "")) });
        return;
      case MCP_APP_METHODS.updateModelContext:
        // Not offered (no `updateModelContext` capability): accepted and
        // left out, so a view that sends it anyway keeps working.
        this.reply(id, {});
        return;
      default:
        this.replyError(id, METHOD_NOT_FOUND, `${method} is not supported here.`);
    }
  }

  /** The call the view shows: its input, then how it ended. */
  private sendCall(): void {
    this.post({
      jsonrpc: "2.0",
      method: MCP_APP_METHODS.toolInput,
      params: { arguments: this.options.arguments },
    });
    this.post(
      this.options.result === null
        ? {
            jsonrpc: "2.0",
            method: MCP_APP_METHODS.toolCancelled,
            params: { reason: "The call ended without a result." },
          }
        : { jsonrpc: "2.0", method: MCP_APP_METHODS.toolResult, params: this.options.result },
    );
  }
}
