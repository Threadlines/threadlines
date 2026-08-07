import { ProviderDriverKind, ProviderInstanceId } from "@threadlines/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerNotice } from "./composerNotices";
import { ComposerNoticeDock } from "./ComposerNoticeDock";
import type { ProviderSignInFlowView } from "./providerSignIn";
import { buildThreadErrorNotice } from "./threadErrorNotice";

function renderNotice(notice: ComposerNotice | null): string {
  return renderToStaticMarkup(<ComposerNoticeDock notices={notice ? [notice] : []} />);
}

function idleSignIn(overrides: Partial<ProviderSignInFlowView> = {}): ProviderSignInFlowView {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    isActive: false,
    isStarting: false,
    hasRun: false,
    hasFailed: false,
    needsTerminal: false,
    lastLine: "",
    failureDetail: null,
    start: () => {},
    ...overrides,
  };
}

describe("buildThreadErrorNotice", () => {
  it("produces nothing without an error", () => {
    expect(buildThreadErrorNotice({ error: null })).toBe(null);
  });

  it("offers the hidden sign-in flow, not a terminal command, for provider auth failures", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        providerLabel: "Claude",
        authReconnect: {
          provider: ProviderDriverKind.make("claudeAgent"),
          command: "claude auth login",
          message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        },
        signIn: idleSignIn(),
      }),
    );

    expect(markup).toContain("Claude needs sign-in.");
    expect(markup).toContain("Complete the browser step and come back here.");
    expect(markup).toContain("Last error: Failed to authenticate.");
    expect(markup).toContain(">Sign in<");
    // The command never reaches the user: Threadlines runs it for them.
    expect(markup).not.toContain("claude auth login");
    expect(markup).toContain('data-composer-notice-severity="error"');
    expect(markup).toContain('role="alert"');
  });

  it("reports a running sign-in on the row instead of the action", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        providerLabel: "Claude",
        authReconnect: {
          provider: ProviderDriverKind.make("claudeAgent"),
          command: "claude auth login",
          message: "Failed to authenticate.",
        },
        signIn: idleSignIn({
          isActive: true,
          hasRun: true,
          lastLine: "Opening browser to complete sign-in",
        }),
      }),
    );

    expect(markup).toContain("Signing in to Claude.");
    expect(markup).toContain("Opening browser to complete sign-in");
    expect(markup).not.toContain(">Sign in<");
  });

  it("renders a Codex usage reset action for usage-limit errors", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "You've hit your usage limit.",
        usageReset: {
          availableCount: 2,
          onReset: () => {},
        },
      }),
    );

    expect(markup).toContain("Turn failed.");
    expect(markup).toContain("usage limit.");
    expect(markup).toContain("Reset usage");
    expect(markup).toContain("Reset Codex usage");
  });

  it("renders a retry action for retryable turn failures", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "API Error: Unable to connect to API (ECONNRESET)",
        retry: {
          isRetrying: false,
          onRetry: () => {},
        },
      }),
    );

    expect(markup).toContain("ECONNRESET");
    expect(markup).toContain(">Retry<");
    expect(markup).toContain("Retry last message");
  });

  it("disables the retry action while a retry is dispatching", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "API Error: Unable to connect to API (ECONNRESET)",
        retry: {
          isRetrying: true,
          onRetry: () => {},
        },
      }),
    );

    expect(markup).toContain("Retrying");
    expect(markup).toContain("disabled");
  });

  it("omits the retry action when no retry handler is provided", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({ error: "API Error: some validation problem" }),
    );

    expect(markup).not.toContain("Retry last message");
  });
});
