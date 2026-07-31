import { assert, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { CopilotClientOptions, SessionConfig } from "@github/copilot-sdk";

import {
  createHumanReviewFallback,
  parseReleaseContentPolicy,
  parseReleaseEvidenceLog,
  renderChangelogEntry,
  renderDraftPrBody,
  requestReleaseSummary,
  validateReleaseSummary,
  type ReleaseEvidenceCommit,
  type ReleaseSummaryDraft,
} from "./generate-release-content.ts";

const evidence: ReadonlyArray<ReleaseEvidenceCommit> = [
  {
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    shortHash: "aaaaaaaa",
    subject: "Add goal mode",
    body: "Let people set an objective and token budget.",
    paths: ["apps/web/src/components/Goal.tsx"],
  },
  {
    hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    shortHash: "bbbbbbbb",
    subject: "Stream subagent progress",
    body: "Show current subagent text in the activity view.",
    paths: ["apps/web/src/components/Activity.tsx"],
  },
];

const draft: ReleaseSummaryDraft = {
  version: "0.2.5",
  title: "Goals and visible subagents",
  summary: "Set durable goals and follow subagent work as it happens.",
  highlights: [
    {
      title: "Codex Goals",
      description: "Set an objective and optional token budget from the composer.",
      evidence: ["aaaaaaaa"],
    },
    {
      title: "Visible subagents",
      description: "Follow live subagent progress from the activity view.",
      evidence: ["bbbbbbbb"],
    },
  ],
  alsoImproved: [],
  social:
    "Threadlines v0.2.5 is out 🧵\n\n• Codex Goals\n• Live subagent progress\n\nRelease notes: https://github.com/Threadlines/threadlines/releases/tag/v0.2.5",
};

const excludedTopics = parseReleaseContentPolicy(`
excludedTopics:
  - name: Realtime voice mode
    reason: It is dormant and unavailable to users.
    terms:
      - realtime voice
      - voice mode
`);

it("turns a grounded summary into editable changelog and PR review artifacts", () => {
  const validated = validateReleaseSummary(draft, {
    version: "0.2.5",
    repository: "Threadlines/threadlines",
    evidence,
  });
  const changelog = renderChangelogEntry(validated, {
    releaseDate: "2026-07-22",
    repository: "Threadlines/threadlines",
  });
  const frontmatter = changelog.slice(4, changelog.lastIndexOf("---")).trim();
  const parsed = parseYaml(frontmatter) as Record<string, unknown>;

  assert.equal(parsed.version, "0.2.5");
  assert.equal(parsed.social, draft.social);
  assert.deepEqual(parsed.highlights, draft.highlights);

  const prBody = renderDraftPrBody(validated, {
    repository: "Threadlines/threadlines",
    previousTag: "v0.2.4",
    currentRef: "main",
  });
  assert.match(prBody, /X draft/);
  assert.match(
    prBody,
    /\[`aaaaaaaa`\]\(https:\/\/github\.com\/Threadlines\/threadlines\/commit\/aaaaaaaa\)/,
  );
  assert.match(prBody, /Merging approves the website and GitHub release copy/);
});

it("rejects public claims that cite commits outside the release range", () => {
  assert.throws(
    () =>
      validateReleaseSummary(
        {
          ...draft,
          highlights: [
            { ...draft.highlights[0], evidence: ["not-a-release-commit"] },
            draft.highlights[1],
          ],
        },
        { version: "0.2.5", repository: "Threadlines/threadlines", evidence },
      ),
    /unknown evidence hash/,
  );
});

it("rejects public copy for features excluded by release policy", () => {
  assert.throws(
    () =>
      validateReleaseSummary(
        {
          ...draft,
          highlights: [
            {
              ...draft.highlights[0],
              title: "Realtime voice mode",
              description: "Talk to Codex from the composer.",
            },
            draft.highlights[1],
          ],
        },
        {
          version: "0.2.5",
          repository: "Threadlines/threadlines",
          evidence,
          excludedTopics,
        },
      ),
    /mentions excluded topic 'Realtime voice mode'/,
  );
});

it("requires the Threadlines thread marker in social drafts", () => {
  assert.throws(
    () =>
      validateReleaseSummary(
        { ...draft, social: draft.social.replace("🧵", "✨") },
        { version: "0.2.5", repository: "Threadlines/threadlines", evidence },
      ),
    /must begin with 'Threadlines v0\.2\.5 is out 🧵'/,
  );

  assert.throws(
    () =>
      validateReleaseSummary(
        {
          ...draft,
          social: draft.social.replace("Release notes:", "Read more:"),
        },
        { version: "0.2.5", repository: "Threadlines/threadlines", evidence },
      ),
    /must end with 'Release notes:/,
  );
});

it("rejects release titles that repeat the product or version", () => {
  assert.throws(
    () =>
      validateReleaseSummary(
        { ...draft, title: "Threadlines v0.2.5: Goals and visible subagents" },
        { version: "0.2.5", repository: "Threadlines/threadlines", evidence },
      ),
    /must not repeat the product name or version/,
  );
});

it("uses Copilot Free auto selection without exposing agent tools", async () => {
  let clientOptions: CopilotClientOptions | undefined;
  let sessionConfig: SessionConfig | undefined;
  let prompt: string | undefined;
  let timeout: number | undefined;
  let disconnected = 0;
  let stopped = 0;
  const unnormalizedDraft = {
    ...draft,
    title: "Threadlines v0.2.5: Goals and visible subagents",
    social: draft.social.replace(
      `\n\nRelease notes: https://github.com/Threadlines/threadlines/releases/tag/v0.2.5`,
      ` https://github.com/Threadlines/threadlines/releases/tag/v0.2.5`,
    ),
  };

  const result = await requestReleaseSummary(
    {
      version: "0.2.5",
      releaseDate: "2026-07-22",
      previousTag: "v0.2.4",
      currentRef: "main",
      repository: "Threadlines/threadlines",
      evidence,
      excludedTopics,
    },
    {
      token: "test-token",
      timeoutMs: 1_234,
      createClient: (options) => {
        clientOptions = options;
        return {
          createSession: async (config) => {
            sessionConfig = config;
            return {
              sendAndWait: async (options, timeoutMs) => {
                prompt = options.prompt;
                timeout = timeoutMs;
                return {
                  data: { content: `\`\`\`json\n${JSON.stringify(unnormalizedDraft)}\n\`\`\`` },
                };
              },
              abort: async () => undefined,
              disconnect: async () => {
                disconnected += 1;
              },
            };
          },
          stop: async () => {
            stopped += 1;
            return [];
          },
        };
      },
    },
  );

  assert.deepEqual(result, draft);
  assert.equal(clientOptions?.mode, "empty");
  assert.equal(clientOptions?.gitHubToken, "test-token");
  assert.equal(clientOptions?.useLoggedInUser, false);
  assert.equal(sessionConfig?.model, "auto");
  assert.deepEqual(sessionConfig?.availableTools, []);
  assert.equal(sessionConfig?.skipCustomInstructions, true);
  assert.deepEqual(sessionConfig?.infiniteSessions, { enabled: false });
  assert.match(prompt ?? "", /Realtime voice mode/);
  assert.match(prompt ?? "", /Return only one JSON object/);
  assert.match(prompt ?? "", /"additionalProperties":false/);
  assert.equal(timeout, 1_234);
  assert.equal(disconnected, 1);
  assert.equal(stopped, 1);
});

it("aborts timed-out Copilot work and always cleans up", async () => {
  const input = {
    version: "0.2.5",
    releaseDate: "2026-07-22",
    previousTag: "v0.2.4",
    currentRef: "main",
    repository: "Threadlines/threadlines",
    evidence,
  };
  let aborted = 0;
  let disconnected = 0;
  let stopped = 0;
  await expect(
    requestReleaseSummary(input, {
      token: "test-token",
      createClient: () => ({
        createSession: async () => ({
          sendAndWait: async () => {
            throw new Error("Timed out waiting for session idle");
          },
          abort: async () => {
            aborted += 1;
          },
          disconnect: async () => {
            disconnected += 1;
          },
        }),
        stop: async () => {
          stopped += 1;
          return [];
        },
      }),
    }),
  ).rejects.toThrow("Timed out waiting for session idle");
  assert.equal(aborted, 1);
  assert.equal(disconnected, 1);
  assert.equal(stopped, 1);
});

it("creates a schema-valid fallback that blocks stable publishing", () => {
  const fallback = createHumanReviewFallback({
    version: "0.2.5",
    repository: "Threadlines/threadlines",
    evidence,
  });
  const changelog = renderChangelogEntry(fallback, {
    releaseDate: "2026-07-22",
    repository: "Threadlines/threadlines",
  });
  const frontmatter = changelog.slice(4, changelog.lastIndexOf("---")).trim();
  const parsed = parseYaml(frontmatter) as Record<string, unknown>;

  assert.equal(fallback.reviewRequired, true);
  assert.equal(parsed.reviewRequired, true);
  assert.match(String(parsed.title), /^TODO:/);
  assert.isAtMost(Array.from(fallback.social).length, 280);
  assert.deepEqual(fallback.highlights[0]?.evidence, ["aaaaaaaa"]);

  const prBody = renderDraftPrBody(fallback, {
    repository: "Threadlines/threadlines",
    previousTag: "v0.2.4",
    currentRef: "main",
  });
  assert.match(prBody, /Stable publishing is blocked/);
  assert.match(prBody, /delete the `reviewRequired` field/);
});

it("rejects non-JSON Copilot output", async () => {
  await expect(
    requestReleaseSummary(
      {
        version: "0.2.5",
        releaseDate: "2026-07-22",
        previousTag: "v0.2.4",
        currentRef: "main",
        repository: "Threadlines/threadlines",
        evidence,
      },
      {
        token: "test-token",
        createClient: () => ({
          createSession: async () => ({
            sendAndWait: async () => ({ data: { content: "I cannot summarize this release." } }),
            abort: async () => undefined,
            disconnect: async () => undefined,
          }),
          stop: async () => [],
        }),
      },
    ),
  ).rejects.toThrow("GitHub Copilot returned non-JSON release content");
});

it("parses commit evidence records with optional path data", () => {
  assert.deepEqual(
    parseReleaseEvidenceLog(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x00aaaaaaaa\x00Add goals\x00Details\x00apps/web/Goal.tsx\napps/server/Goal.ts\x1e",
    ),
    [
      {
        hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shortHash: "aaaaaaaa",
        subject: "Add goals",
        body: "Details",
        paths: ["apps/web/Goal.tsx", "apps/server/Goal.ts"],
      },
    ],
  );
});
