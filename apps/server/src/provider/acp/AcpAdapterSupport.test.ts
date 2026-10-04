import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@threadlines/contracts";

import {
  acpAvailableDecisions,
  acpPermissionOptionId,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("answers a permission request with the option the agent offered", () => {
    // Antigravity's command approval, as recorded.
    const options = [
      { optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" },
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ] as const;
    expect(acpPermissionOptionId("accept", options)).toBe("allow");
    expect(acpPermissionOptionId("acceptForSession", options)).toBe("allow_always");
    expect(acpPermissionOptionId("decline", options)).toBe("deny");
    // An edit approval has no "always": that answer is not offered, and
    // asking for it settles for once.
    const editOptions = options.slice(1);
    expect(acpAvailableDecisions(editOptions)).toEqual(["cancel", "decline", "accept"]);
    expect(acpPermissionOptionId("acceptForSession", editOptions)).toBe("allow");
    // A decline never becomes a standing reject: offered only that, it
    // refuses this one request (answered `cancelled`).
    expect(
      acpPermissionOptionId("decline", [
        ...editOptions.slice(0, 1),
        { optionId: "deny_always", name: "Always deny", kind: "reject_always" },
      ]),
    ).toBeUndefined();
    // Nothing fits: never an option the agent didn't offer.
    expect(acpPermissionOptionId("accept", options.slice(0, 1))).toBeUndefined();
    // Agents that list nothing get the conventional ids.
    expect(acpPermissionOptionId("accept", [])).toBe("allow-once");
    expect(acpPermissionOptionId("decline", [])).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
