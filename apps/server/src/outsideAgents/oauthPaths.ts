/**
 * Where outside agents sign in (docs/design/outside-agents.md): the server
 * is its own OAuth authorization server for `/mcp/connect`. These routes are
 * for agents and the browser page an agent opens on this computer only, so
 * they never get the browser API's open CORS, and are never traced (their
 * query strings carry the client id, `state` and the waiting page's secret).
 */
import { makeRoutePatternMatcher } from "../httpRoutePaths.ts";
import { OUTSIDE_AGENT_MCP_PATH } from "./OutsideAgentConnections.ts";

export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${OUTSIDE_AGENT_MCP_PATH}`;
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const REGISTER_PATH = "/oauth/register";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const AUTHORIZE_STATUS_PATH = "/oauth/authorize/status";
export const TOKEN_PATH = "/oauth/token";

const signInRoute = makeRoutePatternMatcher(
  [
    "/oauth",
    "/oauth/*",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/*",
    AUTHORIZATION_SERVER_METADATA_PATH,
    `${AUTHORIZATION_SERVER_METADATA_PATH}/*`,
  ].map((pattern) => [pattern, true] as const),
);

/** Whether a request URL reaches a sign-in route (`/oauth/*`, `/.well-known/oauth-*`), however it is spelled. */
export const isOutsideAgentSignInPath = (url: string): boolean => signInRoute(url) === true;
