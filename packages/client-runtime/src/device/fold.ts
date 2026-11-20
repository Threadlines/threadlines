/**
 * Android foldables through serve-emu's `/api/fold`: read the posture, fold
 * or unfold (docs/design/devices.md, "Round 2"). Ported from T3 Code's
 * deviceFold.ts (MIT, see NOTICE), over the device channel.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { DeviceHubTransport } from "./hubTransport.ts";

export type AndroidFoldPosture = "closed" | "opened";

const FoldReply = Schema.Struct({
  ok: Schema.Literal(true),
  fold: Schema.Struct({
    supported: Schema.Boolean,
    posture: Schema.NullOr(Schema.Literals(["closed", "half_opened", "opened", "flipped", "tent"])),
    hingeAngle: Schema.NullOr(Schema.Finite),
  }),
});
const decodeFoldReply = Schema.decodeUnknownOption(FoldReply);

export type AndroidFoldState = (typeof FoldReply.Type)["fold"];

const errorText = (payload: unknown, status: number) =>
  typeof payload === "object" &&
  payload !== null &&
  "error" in payload &&
  typeof payload.error === "string"
    ? payload.error
    : `The fold command failed (${status}).`;

const foldRequest = async (
  transport: DeviceHubTransport,
  deviceId: string,
  posture: AndroidFoldPosture | undefined,
  signal: AbortSignal | undefined,
): Promise<AndroidFoldState> => {
  const response = await transport.fetch(
    `/vendor/serve-emu/api/fold?device=${encodeURIComponent(deviceId)}`,
    {
      method: posture ? "POST" : "GET",
      ...(posture ? { body: JSON.stringify({ posture }), contentType: "application/json" } : {}),
      ...(signal ? { signal } : {}),
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(payload, response.status));
  const reply = decodeFoldReply(payload);
  if (Option.isNone(reply)) throw new Error("The emulator sent an unexpected fold reply.");
  return reply.value.fold;
};

/** The emulator's fold sensor and posture; `supported: false` on a phone without a hinge. */
export const readAndroidFold = (
  transport: DeviceHubTransport,
  deviceId: string,
  signal?: AbortSignal,
) => foldRequest(transport, deviceId, undefined, signal);

/** Folds or unfolds, and answers with the posture the emulator reports after. */
export const setAndroidFold = (
  transport: DeviceHubTransport,
  deviceId: string,
  posture: AndroidFoldPosture,
  signal?: AbortSignal,
) => foldRequest(transport, deviceId, posture, signal);

/** Folded far enough that the outer screen is in use. */
export const androidFoldClosed = (fold: AndroidFoldState) =>
  fold.posture === "closed" || (fold.posture === null && (fold.hingeAngle ?? 180) <= 5);
