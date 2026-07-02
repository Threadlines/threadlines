import { ProviderDriverKind } from "@threadlines/contracts";
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

  it("renders a Codex usage reset action for usage-limit errors", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="You've hit your usage limit."
        usageReset={{
          availableCount: 2,
          onReset: () => {},
        }}
      />,
    );

    expect(markup).toContain("usage limit.");
    expect(markup).toContain("Reset usage");
    expect(markup).toContain("Reset Codex usage");
  });

  it("renders a retry action for retryable turn failures", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="API Error: Unable to connect to API (ECONNRESET)"
        retry={{
          isRetrying: false,
          onRetry: () => {},
        }}
      />,
    );

    expect(markup).toContain("ECONNRESET");
    expect(markup).toContain(">Retry<");
    expect(markup).toContain("Retry last message");
  });

  it("disables the retry action while a retry is dispatching", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="API Error: Unable to connect to API (ECONNRESET)"
        retry={{
          isRetrying: true,
          onRetry: () => {},
        }}
      />,
    );

    expect(markup).toContain("Retrying");
    expect(markup).toContain("disabled");
  });

  it("omits the retry action when no retry handler is provided", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="API Error: some validation problem" />,
    );

    expect(markup).not.toContain("Retry last message");
  });
});
