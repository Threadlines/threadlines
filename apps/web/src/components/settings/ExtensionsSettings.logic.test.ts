import { describe, expect, it } from "vitest";

import {
  buildExtensionJsonSchemaFormArguments,
  deriveDetectedProviderThreadId,
  deriveExtensionJsonSchemaFormFields,
  extensionTextMatchesFilter,
  extensionProviderDriverSortRank,
  isLikelyLocalPath,
  makeExtensionJsonSchemaFormDefaults,
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

  it("derives a compact form from simple JSON object schemas", () => {
    const fields = deriveExtensionJsonSchemaFormFields({
      type: "object",
      required: ["projectId", "dryRun"],
      properties: {
        projectId: {
          type: "string",
          description: "Supabase project ref",
        },
        limit: {
          type: "integer",
          default: 25,
        },
        dryRun: {
          type: "boolean",
          default: true,
        },
        filter: {
          type: "object",
          default: { schema: "public" },
        },
      },
    });

    expect(fields?.map((field) => [field.name, field.type, field.required])).toEqual([
      ["projectId", "string", true],
      ["limit", "number", false],
      ["dryRun", "boolean", true],
      ["filter", "json", false],
    ]);
    expect(makeExtensionJsonSchemaFormDefaults(fields ?? [])).toEqual({
      projectId: "",
      limit: "25",
      dryRun: true,
      filter: '{\n  "schema": "public"\n}',
    });
  });

  it("builds MCP tool arguments from schema form values", () => {
    const fields = deriveExtensionJsonSchemaFormFields({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        enabled: { type: "boolean" },
        options: { type: "object" },
      },
    });

    expect(
      buildExtensionJsonSchemaFormArguments(fields ?? [], {
        name: "demo",
        count: "2",
        enabled: false,
        options: '{"safe":true}',
      }),
    ).toEqual({
      name: "demo",
      count: 2,
      enabled: false,
      options: { safe: true },
    });
  });

  it("falls back to raw JSON for schemas that are too large for the inline form", () => {
    expect(
      deriveExtensionJsonSchemaFormFields({
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 25 }, (_, index) => [`field${index}`, { type: "string" }]),
        ),
      }),
    ).toBeNull();
  });
});
