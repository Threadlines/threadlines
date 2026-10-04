import type { EnvironmentId } from "@threadlines/contracts";
import type { StoredKeyPair } from "@threadlines/shared/relaySecure";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { readSavedEnvironmentBearerToken, writeSavedEnvironmentBearerToken } from "./catalog";

/**
 * What a "Connect a device" device keeps in its saved-computer secret slot:
 * the relay secret (only ever sent to the relay, to open its sockets) and its
 * end-to-end key pair (never sent anywhere; the public half went to the host
 * at pairing). Callers take the field they need; nothing passes the whole
 * value on.
 */
export interface RelayDeviceCredentials {
  readonly deviceSecret: string;
  readonly deviceKey: StoredKeyPair;
}

const RelayDeviceCredentialsJson = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(2),
    deviceSecret: Schema.String,
    deviceKey: Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String }),
  }),
);
const decodeCredentials = Schema.decodeUnknownOption(RelayDeviceCredentialsJson);
const encodeCredentials = Schema.encodeSync(RelayDeviceCredentialsJson);

/** Null when missing or not in this format (the computer then has to be connected again). */
export async function readRelayDeviceCredentials(
  environmentId: EnvironmentId,
): Promise<RelayDeviceCredentials | null> {
  const raw = await readSavedEnvironmentBearerToken(environmentId);
  if (!raw) return null;
  const decoded = decodeCredentials(raw);
  return Option.isSome(decoded)
    ? { deviceSecret: decoded.value.deviceSecret, deviceKey: decoded.value.deviceKey }
    : null;
}

export function writeRelayDeviceCredentials(
  environmentId: EnvironmentId,
  credentials: RelayDeviceCredentials,
): Promise<boolean> {
  return writeSavedEnvironmentBearerToken(
    environmentId,
    encodeCredentials({ v: 2, ...credentials }),
  );
}
