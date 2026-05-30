import { describe, expect, it } from "vitest";

import {
  deriveDetectedProviderThreadId,
  extensionTextMatchesFilter,
  extensionProviderDriverSortRank,
  isLikelyLocalPath,
} from "./ExtensionsSettings.logic";

describe("ExtensionsSettings logic", () => {
  it("matches extension records case-insensitively across provided fields", () => {
    expect(extensionTextMatchesFilter(["Browser", "Control the in-app browser"], "BROW")).toBe(
      true,
    );
    expect(extensionTextMatchesFilter(["GitHub", "Triages PRs"], "browser")).toBe(false);
  });

  it("treats empty filters as a match", () => {
    expect(extensionTextMatchesFilter([], "   ")).toBe(true);
  });

  it("detects local file paths without treating URLs as paths", () => {
    expect(isLikelyLocalPath("C:\\Users\\wilfr\\.codex\\skills\\foo\\SKILL.md")).toBe(true);
    expect(isLikelyLocalPath("/Users/wilfr/.codex/skills/foo/SKILL.md")).toBe(true);
    expect(isLikelyLocalPath("https://example.com/plugin")).toBe(false);
  });

  it("sorts Codex providers before Claude providers", () => {
    const providers = ["claudeAgent", "codex", "other"].toSorted(
      (left, right) =>
        extensionProviderDriverSortRank(left) - extensionProviderDriverSortRank(right),
    );

    expect(providers).toEqual(["codex", "claudeAgent", "other"]);
  });

  it("detects the most recently visited matching provider thread", () => {
    expect(
      deriveDetectedProviderThreadId({
        cwd: "C:\\Repo\\BadCode",
        providerDriver: "codex",
        providerInstanceId: "codex",
        projects: [
          {
            environmentId: "local",
            id: "project-a",
            cwd: "c:/repo/badcode",
          },
        ],
        threads: [
          {
            key: "local:thread-old",
            environmentId: "local",
            id: "thread-old",
            projectId: "project-a",
            provider: "codex",
            providerInstanceId: "codex",
            providerThreadId: "codex-thread-old",
            updatedAt: "2026-05-30T10:00:00.000Z",
          },
          {
            key: "local:thread-new",
            environmentId: "local",
            id: "thread-new",
            projectId: "project-a",
            provider: "codex",
            providerInstanceId: "codex",
            providerThreadId: "codex-thread-new",
            updatedAt: "2026-05-30T09:00:00.000Z",
          },
        ],
        threadLastVisitedAtById: {
          "local:thread-new": "2026-05-30T11:00:00.000Z",
        },
      }),
    ).toBe("codex-thread-new");
  });

  it("prefers exact provider instance matches over legacy unscoped thread sessions", () => {
    expect(
      deriveDetectedProviderThreadId({
        cwd: "C:\\Repo\\BadCode",
        providerDriver: "codex",
        providerInstanceId: "codex-personal",
        projects: [
          {
            environmentId: "local",
            id: "project-a",
            cwd: "C:\\Repo\\BadCode",
          },
        ],
        threads: [
          {
            key: "local:thread-legacy",
            environmentId: "local",
            id: "thread-legacy",
            projectId: "project-a",
            provider: "codex",
            providerThreadId: "legacy-thread",
            updatedAt: "2026-05-30T12:00:00.000Z",
          },
          {
            key: "local:thread-exact",
            environmentId: "local",
            id: "thread-exact",
            projectId: "project-a",
            provider: "codex",
            providerInstanceId: "codex-personal",
            providerThreadId: "exact-thread",
            updatedAt: "2026-05-30T10:00:00.000Z",
          },
        ],
        threadLastVisitedAtById: {},
      }),
    ).toBe("exact-thread");
  });

  it("ignores mismatched projects and providers", () => {
    expect(
      deriveDetectedProviderThreadId({
        cwd: "C:\\Repo\\BadCode",
        providerDriver: "codex",
        providerInstanceId: "codex",
        projects: [
          {
            environmentId: "local",
            id: "project-a",
            cwd: "C:\\Repo\\BadCode",
          },
        ],
        threads: [
          {
            key: "local:thread-other-project",
            environmentId: "local",
            id: "thread-other-project",
            projectId: "project-b",
            provider: "codex",
            providerInstanceId: "codex",
            providerThreadId: "other-project-thread",
          },
          {
            key: "local:thread-other-provider",
            environmentId: "local",
            id: "thread-other-provider",
            projectId: "project-a",
            provider: "claudeAgent",
            providerInstanceId: "claude",
            providerThreadId: "other-provider-thread",
          },
        ],
        threadLastVisitedAtById: {},
      }),
    ).toBe("");
  });
});
