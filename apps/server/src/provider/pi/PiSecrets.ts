/**
 * How a chat's Pi gets the Threadlines extension's secrets: the tool servers'
 * token and the per-process nonce. Not in the environment, which stays
 * readable for the process's whole life (`/proc/<pid>/environ` on Linux,
 * `ps eww` on macOS), where Pi's own `read` tool could reach it. They go in a
 * file only this user can read; the extension reads it at load and deletes
 * it, and the adapter deletes any left behind.
 *
 * @module provider/pi/PiSecrets
 */
// @effect-diagnostics nodeBuiltinImport:off - writes one private file before Pi starts
import { randomBytes } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

export interface PiSecrets {
  readonly token: string;
  readonly nonce: string;
}

/** Writes the secrets to a new file under `dir` (created private) and returns its path. */
export async function writePiSecretsFile(dir: string, secrets: PiSecrets): Promise<string> {
  await NodeFS.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = NodePath.join(dir, `${randomBytes(16).toString("hex")}.json`);
  await NodeFS.writeFile(path, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });
  return path;
}

/** Deletes a secrets file if it is still there. Never fails. */
export async function removePiSecretsFile(path: string): Promise<void> {
  await NodeFS.rm(path, { force: true }).catch(() => undefined);
}
