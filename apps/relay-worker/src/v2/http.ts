import type { JoinInput } from "./hostCore.ts";

/** HTTP status for a join failure code. */
export function joinErrorStatus(code: string): number {
  switch (code) {
    case "invalid-code":
      return 404;
    case "invalid-invite":
      return 403;
    case "expired":
      return 410;
    case "busy":
    case "too-many-devices":
      return 409;
    case "rate-limited":
      return 429;
    default:
      return 400;
  }
}

/** A base64url value of bounded length, as keys, hashes, nonces, and proofs are sent. */
export function base64UrlField(value: unknown, max: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : null;
}

/**
 * Validates the shared shape of code joins and QR claims. Code joins carry the
 * joiner's commitment; QR claims carry the claim token and proof.
 */
export function parseJoinBody(
  body: Record<string, unknown> | null,
  kind: "code" | "claim",
): {
  readonly joinId: string;
  readonly deviceSecretHash: string;
  readonly requestSecretHash: string;
  readonly devicePublicKey: string;
  /** The code, or the claim token. */
  readonly secret: string;
  readonly commitment?: string;
  readonly claimProof?: string;
  readonly joiner: JoinInput["joiner"];
} | null {
  if (!body) return null;
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max
      ? value.trim()
      : null;
  const joinId = text(body.joinId, 100);
  const deviceSecretHash = text(body.deviceSecretHash, 100);
  const requestSecretHash = text(body.requestSecretHash, 100);
  const devicePublicKey = base64UrlField(body.devicePublicKey, 120);
  const secret = kind === "code" ? text(body.code, 20) : base64UrlField(body.claimToken, 100);
  const commitment = kind === "code" ? base64UrlField(body.commitment, 100) : null;
  const claimProof = kind === "claim" ? base64UrlField(body.claimProof, 100) : null;
  const joiner = body.joiner as Record<string, unknown> | undefined;
  const label = text(joiner?.label, 120);
  const platform = joiner?.platform === undefined ? null : text(joiner.platform, 80);
  const joinerKind = joiner?.kind;
  if (
    !joinId ||
    !deviceSecretHash ||
    !requestSecretHash ||
    !devicePublicKey ||
    !secret ||
    (kind === "code" ? !commitment : !claimProof) ||
    !label ||
    (joinerKind !== "computer" &&
      joinerKind !== "phone" &&
      joinerKind !== "tablet" &&
      joinerKind !== "browser")
  ) {
    return null;
  }
  return {
    joinId,
    deviceSecretHash,
    requestSecretHash,
    devicePublicKey,
    secret,
    ...(commitment ? { commitment } : {}),
    ...(claimProof ? { claimProof } : {}),
    joiner: { label, kind: joinerKind, ...(platform ? { platform } : {}) },
  };
}
