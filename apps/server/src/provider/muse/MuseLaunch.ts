/**
 * How a `muse serve` host is launched for each kind of work: its flags, the
 * permission profile and approval mode its session selects, and its
 * environment. Pure, so the table is tested on its own
 * (docs/providers/muse-code-plan.md, "Launch flags and session settings").
 *
 * A host's flags and its sessions' profile are fixed for the host's life
 * (a same-host resume keeps the old profile), so any change between turns
 * means a new host.
 *
 * @module provider/muse/MuseLaunch
 */
// @effect-diagnostics nodeBuiltinImport:off -- the native realpath fixes case and 8.3 names on Windows.
import { realpathSync } from "node:fs";

import type { ProviderInstanceEnvironment, RuntimeMode } from "@threadlines/contracts";

import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

/** Muse's built-in permission profiles (`session/start` / `session/resume`). */
export type MusePermissionProfile = ":ask-me" | ":auto-review" | ":read-only" | ":unrestricted";

/** MSP approval modes (`session/start`, `session/setApprovalMode`). */
export type MuseApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";

/** What a host is for. */
export type MuseHostPurpose =
  /** A thread's own conversation. */
  | "chat"
  /** A thread in plan mode: read-only, the answer is a plan. */
  | "plan"
  /** Status checks and title generation: nothing it starts can act. */
  | "utility";

export interface MuseHostProfile {
  /** `serve` and its flags. */
  readonly args: ReadonlyArray<string>;
  /** Absent for ephemeral hosts, which refuse any profile. */
  readonly permissionProfile: MusePermissionProfile | undefined;
  readonly approvalMode: MuseApprovalMode;
  /** The adapter approves workspace file writes itself (auto-accept edits). */
  readonly autoApproveWorkspaceWrites: boolean;
  /** The adapter approves subagent requests itself (Muse does not pass `allowAll` down). */
  readonly autoApproveSubagents: boolean;
}

export interface MuseHostProfileInput {
  readonly purpose: MuseHostPurpose;
  readonly runtimeMode: RuntimeMode;
  /** Data sharing: `--contributor-mode on|off`. `undefined` leaves Muse's own default. */
  readonly contributorMode: boolean | undefined;
  /**
   * Whether the last host on this machine reported it can enforce the shell
   * sandbox. Anything but `true` counts as no: a plan host then turns the
   * shell off too.
   */
  readonly sandboxAvailable: boolean | undefined;
}

/**
 * The flags, profile and approval mode for one host. See the table in
 * docs/providers/muse-code-plan.md.
 */
export function museHostProfile(input: MuseHostProfileInput): MuseHostProfile {
  const contributor =
    input.contributorMode === undefined
      ? []
      : ["--contributor-mode", input.contributorMode ? "on" : "off"];
  if (input.purpose === "utility") {
    return {
      args: ["serve", "--no-session-log", "--disable-shell", "--disable-write", ...contributor],
      permissionProfile: undefined,
      approvalMode: "denyUnmatched",
      autoApproveWorkspaceWrites: false,
      autoApproveSubagents: false,
    };
  }
  if (input.purpose === "plan") {
    return {
      args: [
        "serve",
        "--trust-workspace",
        "--disable-write",
        ...(input.sandboxAvailable === true ? [] : ["--disable-shell"]),
        ...contributor,
      ],
      permissionProfile: ":read-only",
      approvalMode: "promptUnmatched",
      autoApproveWorkspaceWrites: false,
      autoApproveSubagents: false,
    };
  }
  switch (input.runtimeMode) {
    case "full-access":
      return {
        args: ["serve", "--trust-workspace", "--disable-sandbox", ...contributor],
        permissionProfile: ":unrestricted",
        approvalMode: "allowAll",
        autoApproveWorkspaceWrites: false,
        autoApproveSubagents: true,
      };
    case "auto":
      return {
        args: ["serve", "--trust-workspace", ...contributor],
        permissionProfile: ":auto-review",
        approvalMode: "promptUnmatched",
        autoApproveWorkspaceWrites: false,
        autoApproveSubagents: false,
      };
    case "auto-accept-edits":
      return {
        args: ["serve", "--trust-workspace", ...contributor],
        permissionProfile: ":ask-me",
        approvalMode: "promptUnmatched",
        autoApproveWorkspaceWrites: true,
        autoApproveSubagents: false,
      };
    case "approval-required":
      return {
        args: ["serve", "--trust-workspace", ...contributor],
        permissionProfile: ":ask-me",
        approvalMode: "promptUnmatched",
        autoApproveWorkspaceWrites: false,
        autoApproveSubagents: false,
      };
  }
}

/** Two profiles that need different hosts (anything but the auto-approval rules differs). */
export function museHostProfilesDiffer(a: MuseHostProfile, b: MuseHostProfile): boolean {
  return (
    a.permissionProfile !== b.permissionProfile ||
    a.approvalMode !== b.approvalMode ||
    a.args.length !== b.args.length ||
    a.args.some((arg, index) => arg !== b.args[index])
  );
}

/** The variable Muse reads an API key from, ahead of every other credential. */
export const MUSE_API_KEY_ENV = "META_API_KEY";

/**
 * A host's environment: the server's own, without an inherited
 * `META_API_KEY` (a key bills per use and outranks the plan's sign-in), then
 * the instance's own variables (a key set there is a deliberate choice),
 * then `MUSE_NO_AUTO_UPDATE=1` so the launcher never swaps the binary under a
 * live host.
 */
export function museHostEnvironment(
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (name.toUpperCase() !== MUSE_API_KEY_ENV) base[name] = value;
  }
  return {
    ...mergeProviderInstanceEnvironment(instanceEnvironment, base),
    MUSE_NO_AUTO_UPDATE: "1",
  };
}

/**
 * Rebuilds `target` in place as {@link museHostEnvironment}, dropping names
 * the new environment no longer has. The driver hands one object to every
 * host and refreshes it from the shell, so a plain merge would bring an
 * inherited key back.
 */
export function refreshMuseHostEnvironment(
  target: NodeJS.ProcessEnv,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): void {
  const next = museHostEnvironment(instanceEnvironment, baseEnv);
  for (const name of Object.keys(target)) {
    if (!Object.hasOwn(next, name)) delete target[name];
  }
  Object.assign(target, next);
}

/** Whether the instance itself sets an API key (the per-use opt-in still applies). */
export function instanceSetsMuseApiKey(
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
): boolean {
  return (instanceEnvironment ?? []).some(
    (variable) => variable.name.toUpperCase() === MUSE_API_KEY_ENV && variable.value.trim() !== "",
  );
}

/** Why Muse may not run on its credential, or `undefined` when it may. */
export type MuseBillingRefusal = "apiKey" | "unknown";

/**
 * The per-use gate, shared by chats, text generation and the status check:
 * Muse never runs on an API key unless the instance allows per-use billing.
 * A sign-in Threadlines cannot read (no experimental API, a failed
 * `account/read`, a state it does not know) counts as a possible key, so a
 * check that breaks stops Muse instead of billing.
 */
export function museBillingRefusal(input: {
  readonly allowApiKeyBilling: boolean;
  /** `account/read`'s `state`, when Threadlines could read it. */
  readonly accountState: string | undefined;
  readonly instanceEnvironment: ProviderInstanceEnvironment | undefined;
}): MuseBillingRefusal | undefined {
  if (input.allowApiKeyBilling) return undefined;
  if (instanceSetsMuseApiKey(input.instanceEnvironment)) return "apiKey";
  switch (input.accountState) {
    case "accountLogin":
    case "loggedOut":
      return undefined;
    case "apiKey":
    case "envKey":
      return "apiKey";
    default:
      return "unknown";
  }
}

const BILLING_SWITCH = '"Allow API key billing" on the Muse Code Account tab in Settings';

/** What the user reads when {@link museBillingRefusal} stops Muse. */
export function describeMuseBillingRefusal(refusal: MuseBillingRefusal): string {
  return refusal === "apiKey"
    ? `Muse Code is set up with an API key, which Meta bills per use. Turn on ${BILLING_SWITCH}, or sign in with your Meta account to use your plan (\`muse logout\`, then Sign in).`
    : `Threadlines couldn't tell how Muse Code is signed in, and an API key would bill per use, so it didn't start Muse. Sign in again, or turn on ${BILLING_SWITCH} to run anyway.`;
}

/** Windows' verbatim form of a canonical path: `\\?\C:\…`, or `\\?\UNC\server\share\…`. */
export function museVerbatimPath(path: string): string {
  if (path.startsWith("\\\\?\\")) return path;
  return path.startsWith("\\\\") ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`;
}

/**
 * A workspace root as `session/start` and `turn/start` accept it. On Windows
 * Muse takes only the verbatim canonical path (true case, long names), so it
 * is resolved with the native realpath. Elsewhere the path is already
 * realpath'd by the caller (Muse rejects symlinked roots such as macOS /tmp).
 */
export function museWorkspaceRoot(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return path;
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    // A verbatim path takes `/` literally.
    canonical = path.replaceAll("/", "\\");
  }
  return museVerbatimPath(canonical);
}
