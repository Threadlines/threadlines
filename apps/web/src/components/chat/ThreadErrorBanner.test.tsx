import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("renders provider auth recovery steps and terminal action", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="Failed to authenticate. API Error: 401 Invalid authentication credentials"
        providerLabel="Claude"
        authReconnect={{
          provider: ProviderDriverKind.make("claudeAgent"),
          command: "claude auth login",
          message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        }}
        onRunAuthReconnect={() => {}}
      />,
    );

    expect(markup).toContain("Claude sign-in required");
    expect(markup).toContain("claude auth login");
    expect(markup).toContain("complete the browser sign-in");
    expect(markup).toContain("Sign in in terminal");
  });
});
