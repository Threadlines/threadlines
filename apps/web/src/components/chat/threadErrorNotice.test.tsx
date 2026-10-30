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
    elsewhere: null,
    canReachComputer: true,
    hasFailed: false,
    needsHandoff: false,
    asking: false,
    waitingInHandoff: false,
    lastLine: "",
    failureDetail: null,
    start: () => {},
    ...overrides,
  };
}

describe("buildThreadErrorNotice", () => {
  it("explains writer conflicts and keeps retry available", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "thread abc already has an active writer (code -32600)",
        retry: { isRetrying: false, onRetry: () => {} },
      }),
    );
    expect(markup).toContain("Conversation open elsewhere.");
    expect(markup).toContain("Close this conversation in the other Codex window");
    expect(markup).toContain("Retry last message");
  });
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
    expect(markup).toContain("Sign in, then retry your message.");
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

  it("offers the provider's upgrade page for plan-gated turn failures", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "Upgrade your plan to continue",
        providerLabel: "Cursor",
        planUpgradeUrl: "https://cursor.com/settings",
        retry: { isRetrying: false, onRetry: () => {} },
      }),
    );

    expect(markup).toContain("Cursor plan limit.");
    expect(markup).toContain("Upgrade your plan to continue");
    expect(markup).toContain(">Upgrade plan<");
    expect(markup).toContain('data-composer-notice-severity="warning"');
    // Retrying a plan-gated model fails by construction; the action is omitted.
    expect(markup).not.toContain(">Retry<");
  });

  it("keeps the plain failure notice when the provider has no upgrade page", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "Upgrade your plan to continue",
        providerLabel: "Cursor",
        planUpgradeUrl: null,
      }),
    );
    expect(markup).toContain("Turn failed.");
    expect(markup).not.toContain(">Upgrade plan<");
  });

  it("renders a Codex usage reset action for usage-limit errors", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "You've hit your usage limit.",
        providerLabel: "Codex",
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

  it("links to the provider's own reset page when resets cannot be claimed here", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: "You've hit your usage limit.",
        providerLabel: "Claude",
        usageResetLink: { label: "Use on claude.ai", url: "https://claude.ai/settings/usage" },
      }),
    );

    expect(markup).toContain("Use on claude.ai");
    expect(markup).not.toContain("Reset usage");
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

describe("buildThreadErrorNotice for a usage limit", () => {
  const limitText = "You've hit your session limit · resets 2:20pm (America/New_York)";
  const usageLimit = (continueAt: string | null) => ({
    window: "session" as const,
    resetsAt: "2026-01-01T19:20:00.000Z",
    continueAt,
    canContinue: true,
    isSaving: false,
    onContinueChange: () => {},
  });

  it("names the limit and offers the switch and the user's other account by name", () => {
    const notice = buildThreadErrorNotice({
      error: limitText,
      agentLabel: "Claude",
      usageLimit: usageLimit(null),
      accountSwitch: {
        accounts: [{ instanceId: "claudeAgent_personal", label: "Personal" }],
        isSwitching: false,
        onSwitch: () => {},
      },
      retry: { isRetrying: false, onRetry: () => {} },
      onDismiss: () => {},
    });
    expect(notice?.severity).toBe("warning");
    expect(notice?.lead).toBe("Claude session limit.");
    const markup = renderNotice(notice);
    expect(markup).toContain("Continue at reset");
    expect(markup).toContain("Use Personal");
    // A retry now would hit the same limit; the switch and the account replace it.
    expect(markup).not.toContain("Retry last message");
    expect(notice?.onDismiss).toBeDefined();
  });

  it("says when a waiting thread continues, and can't be closed while it waits", () => {
    const notice = buildThreadErrorNotice({
      error: limitText,
      agentLabel: "Claude",
      usageLimit: usageLimit("2026-01-01T19:21:00.000Z"),
      onDismiss: () => {},
    });
    expect(notice?.severity).toBe("info");
    // React marks where text pieces join; the reader sees one sentence.
    const markup = renderNotice(notice).replaceAll("<!-- -->", "");
    expect(markup).toMatch(/Continues [^<]*at [^<]+\./u);
    expect(markup).toMatch(/Claude&#x27;s session limit resets [^<]*at /u);
    expect(notice?.onDismiss).toBeUndefined();
  });

  it("lists two or more other accounts in a menu", () => {
    const markup = renderNotice(
      buildThreadErrorNotice({
        error: limitText,
        agentLabel: "Claude",
        usageLimit: { ...usageLimit(null), resetsAt: null, canContinue: false },
        accountSwitch: {
          accounts: [
            { instanceId: "claudeAgent_personal", label: "Personal" },
            { instanceId: "claudeAgent_work", label: "Work" },
          ],
          isSwitching: false,
          onSwitch: () => {},
        },
      }),
    );
    expect(markup).toContain("Use another account");
    expect(markup).not.toContain("Continue at reset");
    // Without a reset time, the agent's own words say what happened.
    expect(markup).toContain("You&#x27;ve hit your session limit");
  });
});
