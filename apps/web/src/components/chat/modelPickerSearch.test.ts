import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import {
  resolveModelPickerEmptyState,
  type ModelPickerProviderState,
} from "./modelPickerEmptyState";

describe("buildModelPickerSearchText", () => {
  it("builds provider-agnostic search text from generic fields", () => {
    expect(
      buildModelPickerSearchText({
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        subProvider: "Enterprise",
      }),
    ).toBe("claude opus 4.7 enterprise claudeagent claude");
  });
});

describe("scoreModelPickerSearch", () => {
  it("matches catalog chips so typing 'free' filters to free models", () => {
    const freeModel = {
      driverKind: "fx",
      providerDisplayName: "fx",
      name: "minimax/minimax-m3-free",
      promoLabel: "Free",
      metaLabel: "1M ctx",
    };
    const paidModel = {
      driverKind: "fx",
      providerDisplayName: "fx",
      name: "openai/gpt-5.2",
      metaLabel: "391K ctx · $1.75/M in · $14/M out",
    };
    expect(scoreModelPickerSearch(freeModel, "free")).not.toBeNull();
    expect(scoreModelPickerSearch(paidModel, "free")).toBeNull();
  });

  it("matches typo-tolerant multi-token queries", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "claudeAgent",
          providerDisplayName: "Claude",
          name: "Claude Opus 4.7",
          subProvider: "Enterprise",
        },
        "entr op",
      ),
    ).not.toBeNull();
  });

  it("rejects results when any query token does not match", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "codex",
          providerDisplayName: "codex",
          name: "GPT-5 Codex",
        },
        "entr op",
      ),
    ).toBeNull();
  });

  it("ranks exact token matches ahead of fuzzier matches", () => {
    const exactScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        subProvider: "Enterprise",
      },
      "enterprise opus",
    );
    const fuzzyScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        subProvider: "Enterprise",
      },
      "entr op",
    );

    expect(exactScore).not.toBeNull();
    expect(fuzzyScore).not.toBeNull();
    expect(exactScore!).toBeLessThan(fuzzyScore!);
  });

  it("gives favorite models a strong enough ranking boost for partial queries", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opu",
    );
    const nonFavoriteScore = scoreModelPickerSearch(
      {
        driverKind: "codex",
        providerDisplayName: "Codex",
        name: "Opus 4.5",
      },
      "opu",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteScore).not.toBeNull();
    expect(favoriteScore!).toBeLessThan(nonFavoriteScore!);
  });

  it("does not let the favorite boost outrank clearly better textual matches", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opus 4.7",
    );
    const nonFavoriteExactScore = scoreModelPickerSearch(
      {
        driverKind: "codex",
        providerDisplayName: "Codex",
        name: "Opus 4.7",
      },
      "opus 4.7",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteExactScore).not.toBeNull();
    expect(nonFavoriteExactScore!).toBeLessThan(favoriteScore!);
  });

  it("matches a custom instance's display name against its models", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "codex",
          providerDisplayName: "Codex Personal",
          name: "GPT-5 Codex",
        },
        "personal",
      ),
    ).not.toBeNull();
  });
});

describe("resolveModelPickerEmptyState", () => {
  const makeProvider = (
    driverKind: string,
    displayName: string,
    overrides: Partial<ServerProvider> = {},
  ): ModelPickerProviderState => {
    const snapshot = {
      driver: ProviderDriverKind.make(driverKind),
      instanceId: ProviderInstanceId.make(driverKind),
      displayName,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...overrides,
    } satisfies ServerProvider;
    return {
      displayName,
      driverKind,
      enabled: snapshot.enabled,
      snapshot,
    };
  };

  const CODEX_READY = makeProvider("codex", "Codex");
  const CLAUDE_MISSING = makeProvider("claudeAgent", "Claude", {
    installed: false,
    status: "warning",
    auth: { status: "unknown" },
  });
  const CLAUDE_SIGNED_OUT = makeProvider("claudeAgent", "Claude", {
    status: "warning",
    auth: { status: "unauthenticated" },
  });

  it("explains an uninstalled provider the query names", () => {
    expect(
      resolveModelPickerEmptyState({
        searchQuery: "Claude",
        activeTabKind: "instance",
        providers: [CODEX_READY, CLAUDE_MISSING],
      }),
    ).toEqual({
      lines: ["Claude isn't installed. Install it and sign in from Settings."],
      showSettingsAction: true,
    });
  });

  it("explains a provider that is installed but signed out", () => {
    expect(
      resolveModelPickerEmptyState({
        searchQuery: "claude",
        activeTabKind: "instance",
        providers: [CODEX_READY, CLAUDE_SIGNED_OUT],
      }),
    ).toEqual({
      lines: ["Claude needs sign-in. Connect it from Settings."],
      showSettingsAction: true,
    });
  });

  it("keeps the plain no-match message when the query names no unusable provider", () => {
    expect(
      resolveModelPickerEmptyState({
        searchQuery: "sonnet",
        activeTabKind: "instance",
        providers: [CODEX_READY, CLAUDE_MISSING],
      }),
    ).toEqual({ lines: ["No models match"], showSettingsAction: false });
  });

  it("lists every provider when none of the enabled ones are usable", () => {
    expect(
      resolveModelPickerEmptyState({
        searchQuery: "",
        activeTabKind: "instance",
        providers: [
          makeProvider("codex", "Codex", {
            installed: false,
            status: "warning",
            auth: { status: "unknown" },
            message: "CLI not detected on PATH.",
          }),
          CLAUDE_SIGNED_OUT,
        ],
      }),
    ).toEqual({
      lines: ["Codex · Not found", "Claude · Not authenticated"],
      showSettingsAction: true,
    });
  });

  it("stays generic while at least one enabled provider is usable", () => {
    expect(
      resolveModelPickerEmptyState({
        searchQuery: "",
        activeTabKind: "instance",
        providers: [CODEX_READY, CLAUDE_MISSING],
      }),
    ).toEqual({ lines: ["No models available"], showSettingsAction: false });
  });

  it("keeps the favorites tab message while a provider is still usable", () => {
    expect(
      resolveModelPickerEmptyState({
        searchQuery: "",
        activeTabKind: "favorites",
        providers: [CODEX_READY, CLAUDE_MISSING],
      }),
    ).toEqual({ lines: ["No favorite models"], showSettingsAction: false });
  });

  it("explains providers from the favorites tab on a cold install", () => {
    // A cold install has no usable provider tabs, so Favorites is the only
    // tab the picker can open on; the provider guidance must win there too.
    expect(
      resolveModelPickerEmptyState({
        searchQuery: "",
        activeTabKind: "favorites",
        providers: [
          makeProvider("codex", "Codex", {
            status: "warning",
            auth: { status: "unauthenticated" },
          }),
          CLAUDE_MISSING,
        ],
      }),
    ).toEqual({
      lines: ["Codex · Not authenticated", "Claude · Not found"],
      showSettingsAction: true,
    });
  });
});
