import {
  type AuthSessionRole,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ServerAuthDescriptor,
} from "@threadlines/contracts";
import { HttpResponse, http } from "msw";

const TEST_SESSION_EXPIRES_AT = "2026-05-01T12:00:00.000Z";
const TEST_ENVIRONMENT_DESCRIPTOR: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

/**
 * The session endpoints of a server this app is signed in to. `getRole`
 * says who the session is to it (the computer's owner, a device); absent,
 * the answer names no role, as an older server's does.
 */
export function createAuthenticatedSessionHandlers(
  getAuthDescriptor: () => ServerAuthDescriptor,
  getRole: () => AuthSessionRole | null = () => null,
) {
  return [
    http.get("*/.well-known/threadlines/environment", () =>
      HttpResponse.json(TEST_ENVIRONMENT_DESCRIPTOR),
    ),
    http.get("*/api/auth/session", () =>
      HttpResponse.json({
        authenticated: true,
        auth: getAuthDescriptor(),
        ...(getRole() !== null ? { role: getRole() } : {}),
        sessionMethod: "browser-session-cookie",
        expiresAt: TEST_SESSION_EXPIRES_AT,
      }),
    ),
    http.post("*/api/auth/bootstrap", () =>
      HttpResponse.json({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
        expiresAt: TEST_SESSION_EXPIRES_AT,
      }),
    ),
  ] as const;
}
