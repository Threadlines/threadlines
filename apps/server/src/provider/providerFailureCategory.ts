/**
 * Shared reading of provider failure codes into `ProviderFailureCategory`.
 * Each driver maps its own agent's codes; what several agents report alike,
 * such as an HTTP status, is read here once.
 *
 * @module providerFailureCategory
 */
import type { ProviderFailureCategory } from "@threadlines/contracts";

/** The category an upstream HTTP status names, if it names one. */
export function httpStatusFailureCategory(
  status: number | null | undefined,
): ProviderFailureCategory | undefined {
  if (typeof status !== "number") return undefined;
  if (status === 400) return "validation";
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 408) return "network";
  if (status === 429) return "rate_limit";
  if (status === 503 || status === 529) return "overloaded";
  if (status >= 500 && status <= 599) return "server_error";
  return undefined;
}

/** The `failureCategory` field of an event payload, or nothing when unset. */
export function withFailureCategory(category: ProviderFailureCategory | undefined): {
  readonly failureCategory?: ProviderFailureCategory;
} {
  return category ? { failureCategory: category } : {};
}
