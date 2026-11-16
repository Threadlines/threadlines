/**
 * The computer and project a place link opens a settings page on
 * (`?environment=&project=`, written by appPlaceLinks.ts resolvePlaceLink).
 * Apart from appPlaceLinks so the routes that keep these search params,
 * which load at startup, don't bring the whole place catalog with them.
 */

/**
 * The computer and project a place link asks Plugins & Skills or Agent
 * Instructions to show (`?environment=&project=`, from resolvePlaceLink), or
 * null. Those pages apply it once per arrival, so a later pick of their own
 * stands.
 */
export function placeScopeFromSearch(
  search: Record<string, unknown>,
): { readonly environmentId: string; readonly project: string | null } | null {
  const environmentId = search["environment"];
  if (typeof environmentId !== "string" || environmentId.length === 0) return null;
  const project = search["project"];
  return {
    environmentId,
    project: typeof project === "string" && project.length > 0 ? project : null,
  };
}

/** The search params a page keeps for placeScopeFromSearch. */
export function placeScopeSearch(search: Record<string, unknown>): {
  readonly environment?: string;
  readonly project?: string;
} {
  const scope = placeScopeFromSearch(search);
  return scope === null
    ? {}
    : {
        environment: scope.environmentId,
        ...(scope.project !== null ? { project: scope.project } : {}),
      };
}
