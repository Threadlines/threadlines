import { OutsideAgentConnectionId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isAgentOrigin, isUserWrittenMessage } from "./roomAgentRequests.ts";

describe("isUserWrittenMessage", () => {
  it("never counts an outside agent's message as the user's", () => {
    const fromOutside = {
      connectionId: OutsideAgentConnectionId.make("connection-1"),
      name: "Claude Code",
    };
    expect(isUserWrittenMessage({ role: "user" })).toBe(true);
    expect(isUserWrittenMessage({ role: "user", fromOutside })).toBe(false);
    expect(isAgentOrigin({ fromOutside })).toBe(true);
  });
});
