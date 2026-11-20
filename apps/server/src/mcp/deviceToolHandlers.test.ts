import { describe, expect, it } from "@effect/vitest";
import { type DeviceId, type DeviceSummary, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DeviceService } from "../device/DeviceService.ts";
import { deviceList, pickDevice } from "./deviceToolHandlers.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";

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

describe("device tools under outside work", () => {
  it.effect(
    "refuse while an outside connection's work limits the session, even with devices on",
    () =>
      Effect.gen(function* () {
        const thread = ThreadId.make("thread-outside");
        const caller: McpInvocationScope = {
          threadId: thread,
          sessionKey: thread,
          participantId: null,
          generation: 1,
          agentId: "agent",
          browser: true,
          pages: true,
          commands: true,
          device: true,
          roomTools: new Set(),
          outsideLimit: { names: ["Helper laptop"], projectIds: null },
        };
        const refused = yield* deviceList(caller, {}).pipe(Effect.flip);
        expect(refused.message).toContain("Devices are off for this agent while Helper laptop");
      }).pipe(
        Effect.provide(
          Layer.mock(DeviceService)({
            state: Effect.succeed({ enabled: true, agentAccessEnabled: true } as never),
          }),
        ),
      ),
  );
});
