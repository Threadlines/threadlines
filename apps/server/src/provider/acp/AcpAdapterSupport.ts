import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** ACP's `auth_required`: the agent wants a sign-in before it goes on. */
export function isAcpAuthRequiredError(error: unknown): boolean {
  return isAcpRequestError(error) && error.code === -32000;
}

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

type AcpPermissionOptionKind = EffectAcpSchema.PermissionOption["kind"];

const DECISION_OPTION_KINDS: Record<
  Exclude<ProviderApprovalDecision, "cancel">,
  ReadonlyArray<AcpPermissionOptionKind>
> = {
  // Never upward: "approve once" must not become a standing rule, and
  // neither may "decline".
  acceptForSession: ["allow_always", "allow_once"],
  accept: ["allow_once"],
  decline: ["reject_once"],
};

const CONVENTIONAL_OPTION_IDS: Record<Exclude<ProviderApprovalDecision, "cancel">, string> = {
  acceptForSession: "allow-always",
  accept: "allow-once",
  decline: "reject-once",
};

/**
 * The offered option for a decision, found by its ACP kind: agents name
 * their options freely (Cursor `allow-once`, Antigravity `allow`). "Always"
 * falls back to "once"; nothing falls upward. `undefined` when the request
 * offers nothing that fits: a decline then answers `cancelled`, which refuses
 * this request and leaves no rule. Only an agent that lists no options at all
 * gets the conventional id.
 */
export function acpPermissionOptionId(
  decision: Exclude<ProviderApprovalDecision, "cancel">,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): string | undefined {
  for (const kind of DECISION_OPTION_KINDS[decision]) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option?.optionId.trim()) return option.optionId.trim();
  }
  return options.length > 0 ? undefined : CONVENTIONAL_OPTION_IDS[decision];
}

/** The answers a permission request accepts; `undefined` when it lists no options. */
export function acpAvailableDecisions(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): ReadonlyArray<ProviderApprovalDecision> | undefined {
  if (options.length === 0) return undefined;
  const kinds = new Set(options.map((option) => option.kind));
  return [
    "cancel",
    ...(kinds.has("reject_once") || kinds.has("reject_always") ? (["decline"] as const) : []),
    ...(kinds.has("allow_always") ? (["acceptForSession"] as const) : []),
    ...(kinds.has("allow_once") ? (["accept"] as const) : []),
  ];
}
