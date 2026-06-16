export interface ExtensionMcpAuthStatusInput {
  readonly authStatus?: string | null | undefined;
  readonly status?: string | null | undefined;
  readonly detail?: string | null | undefined;
}

export type ExtensionMcpOAuthActionIntent = "authorize" | "reauth";

const MCP_AUTH_REQUIRED_MARKERS = [
  "unauth",
  "not logged in",
  "notloggedin",
  "not authenticated",
  "needs auth",
  "login required",
  "expired",
] as const;

function normalizedMcpAuthStatusValues(input: ExtensionMcpAuthStatusInput): ReadonlyArray<string> {
  return [input.authStatus, input.status, input.detail].map(
    (value) => value?.trim().toLowerCase() ?? "",
  );
}

export function extensionMcpNeedsAuthStatus(input: ExtensionMcpAuthStatusInput): boolean {
  return normalizedMcpAuthStatusValues(input).some((value) =>
    MCP_AUTH_REQUIRED_MARKERS.some((marker) => value.includes(marker)),
  );
}

export function extensionMcpOAuthActionIntent(
  input: ExtensionMcpAuthStatusInput,
): ExtensionMcpOAuthActionIntent | null {
  const values = normalizedMcpAuthStatusValues(input);
  const needsAuth = extensionMcpNeedsAuthStatus(input);
  const supportsOAuthAction = needsAuth || values.some((value) => value.includes("oauth"));
  if (!supportsOAuthAction) return null;
  return needsAuth ? "authorize" : "reauth";
}

export function extensionMcpOAuthActionLabel(intent: ExtensionMcpOAuthActionIntent | null): string {
  return intent === "reauth" ? "Re-auth" : "Authorize";
}

function commandArg(value: string): string {
  return /^[A-Za-z0-9._:/?=&,-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

export function codexMcpLoginCommand(
  serverName: string,
  scopes: ReadonlyArray<string> = [],
): string {
  const args = ["codex", "mcp", "login", serverName];
  if (scopes.length > 0) {
    args.push("--scopes", scopes.join(","));
  }
  return args.map(commandArg).join(" ");
}
