import { assert, it } from "@effect/vitest";
import { parse as parseYaml } from "yaml";

import {
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

it("uses schema-constrained GitHub Models output", async () => {
  let requestUrl: string | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const unnormalizedDraft = {
    ...draft,
    title: "Threadlines v0.2.5: Goals and visible subagents",
    social: draft.social.replace(
      `\n\nRelease notes: https://github.com/Threadlines/threadlines/releases/tag/v0.2.5`,
      ` https://github.com/Threadlines/threadlines/releases/tag/v0.2.5`,
    ),
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify(unnormalizedDraft),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await requestReleaseSummary(
    {
      version: "0.2.5",
      releaseDate: "2026-07-22",
      previousTag: "v0.2.4",
      currentRef: "main",
      repository: "Threadlines/threadlines",
      evidence,
    },
    { token: "test-token", fetch: fakeFetch },
  );

  assert.deepEqual(result, draft);
  assert.equal(requestUrl, "https://models.github.ai/inference/chat/completions");
  assert.equal(requestBody?.model, "openai/gpt-4.1");
  assert.equal(
    (requestBody?.response_format as { type?: unknown } | undefined)?.type,
    "json_schema",
  );
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
