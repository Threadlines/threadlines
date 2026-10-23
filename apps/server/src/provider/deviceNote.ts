import type { ProviderSendTurnInput, ProviderSteerTurnInput } from "@threadlines/contracts";
import { withContextSeedPreamble } from "@threadlines/shared/contextSeed";

/**
 * A turn or steer with its device note (ProviderSendTurnInput.deviceNote) put
 * in front of `input`, and counted as context in `typed`, for a driver with no
 * way of its own to send it. Codex, OpenCode, Pi and the ACP agents get it
 * this way.
 */
export function withDeviceNoteInFront<T extends ProviderSendTurnInput | ProviderSteerTurnInput>(
  input: T,
): Omit<T, "deviceNote"> {
  const { deviceNote, ...turn } = input;
  if (deviceNote === undefined) {
    return input;
  }
  return {
    ...turn,
    input: withContextSeedPreamble(deviceNote, turn.input),
    ...(turn.typed !== undefined
      ? {
          typed: {
            ...turn.typed,
            context: [deviceNote, turn.typed.context]
              .filter((part): part is string => part !== undefined && part.trim().length > 0)
              .join("\n\n"),
          },
        }
      : {}),
  };
}
