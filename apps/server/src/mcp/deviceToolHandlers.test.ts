import { describe, expect, it } from "@effect/vitest";
import type { DeviceId, DeviceSummary } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import { pickDevice } from "./deviceToolHandlers.ts";

const device = (id: string, overrides: Partial<DeviceSummary>): DeviceSummary => ({
  id: id as DeviceId,
  platform: "android",
  name: id,
  version: "Android 16",
  booted: false,
  physical: false,
  ...overrides,
});

describe("pickDevice", () => {
  it.effect("never picks a plugged-in phone by default, only when named", () =>
    Effect.gen(function* () {
      const phone = device("R5CT1234", { booted: true, physical: true });
      const emulator = device("emulator-5554", {});
      const state = { devices: [phone, emulator], hostStatus: "ready" as const };

      expect((yield* pickDevice(state, { platform: "android" })).id).toBe("emulator-5554");
      expect((yield* pickDevice(state, { deviceId: phone.id })).id).toBe("R5CT1234");
    }),
  );
});
