/**
 * How Threadlines introduces itself to an ACP agent in `initialize`: under
 * its own name and version, never as another editor.
 *
 * @module provider/acp/acpClientInfo
 */
import packageJson from "../../../package.json" with { type: "json" };

export const THREADLINES_ACP_CLIENT_INFO = {
  name: "threadlines",
  title: "Threadlines",
  version: packageJson.version,
} as const;
