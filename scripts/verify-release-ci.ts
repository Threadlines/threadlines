import { appendFileSync } from "node:fs";

type GitHubApp = {
  slug?: string;
};

type CheckRun = {
  app?: GitHubApp;
  completed_at?: string | null;
  conclusion?: string | null;
  details_url?: string;
  html_url?: string;
  name?: string;
  started_at?: string | null;
  status?: string;
};

type CheckRunsResponse = {
  check_runs?: CheckRun[];
};

const DEFAULT_REQUIRED_CHECKS = [
  "Format, Lint, Typecheck, Test, Browser Test, Build",
  "Release Smoke",
];

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readRequiredChecks(): string[] {
  const raw = process.env.REQUIRED_CI_CHECKS;
  if (!raw) {
    return DEFAULT_REQUIRED_CHECKS;
  }

  return raw
    .split(/\r?\n|,/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function compareCheckRuns(a: CheckRun, b: CheckRun): number {
  const aTime = Date.parse(a.completed_at ?? a.started_at ?? "1970-01-01T00:00:00Z");
  const bTime = Date.parse(b.completed_at ?? b.started_at ?? "1970-01-01T00:00:00Z");
  return bTime - aTime;
}

function getNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/u);
    if (match) {
      return match[1] ?? null;
    }
  }

  return null;
}

async function fetchJson(
  url: string,
  token: string,
): Promise<{
  body: CheckRunsResponse;
  nextUrl: string | null;
}> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "threadlines-release-ci-verifier",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed with ${response.status}: ${body}`);
  }

  return {
    body: (await response.json()) as CheckRunsResponse,
    nextUrl: getNextUrl(response.headers.get("link")),
  };
}

async function fetchCheckRuns(repository: string, ref: string, token: string): Promise<CheckRun[]> {
  const encodedRef = encodeURIComponent(ref);
  let nextUrl: string | null =
    `https://api.github.com/repos/${repository}/commits/${encodedRef}/check-runs?filter=latest&per_page=100`;
  const checkRuns: CheckRun[] = [];

  while (nextUrl) {
    const response = await fetchJson(nextUrl, token);
    checkRuns.push(...(response.body.check_runs ?? []));
    nextUrl = response.nextUrl;
  }

  return checkRuns;
}

function writeStepSummary(lines: string[]): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const ref = process.env.RELEASE_CI_REF ?? readRequiredEnv("GITHUB_SHA");
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN or GH_TOKEN for GitHub API access.");
  }

  const requiredChecks = readRequiredChecks();
  const requiredCheckSet = new Set(requiredChecks);
  const checkRuns = (await fetchCheckRuns(repository, ref, token))
    .filter((run) => requiredCheckSet.has(run.name ?? ""))
    .filter((run) => !run.app?.slug || run.app.slug === "github-actions")
    .sort(compareCheckRuns);

  const checksByName = new Map<string, CheckRun>();
  for (const checkRun of checkRuns) {
    if (checkRun.name && !checksByName.has(checkRun.name)) {
      checksByName.set(checkRun.name, checkRun);
    }
  }

  const failures: string[] = [];
  for (const checkName of requiredChecks) {
    const checkRun = checksByName.get(checkName);
    if (!checkRun) {
      failures.push(`${checkName}: missing`);
      continue;
    }

    if (checkRun.status !== "completed" || checkRun.conclusion !== "success") {
      failures.push(
        `${checkName}: status=${checkRun.status ?? "unknown"}, conclusion=${checkRun.conclusion ?? "unknown"} (${checkRun.html_url ?? checkRun.details_url ?? "no URL"})`,
      );
    }
  }

  if (failures.length > 0) {
    const message = [
      "Required CI checks have not passed for this release commit.",
      `Repository: ${repository}`,
      `Commit: ${ref}`,
      "",
      ...failures.map((failure) => `- ${failure}`),
    ];

    writeStepSummary(["### Release CI verification failed", "", ...message]);
    console.error(message.join("\n"));
    process.exitCode = 1;
    return;
  }

  const summary = [
    "### Release CI verification passed",
    "",
    `Commit: ${ref}`,
    "",
    ...requiredChecks.map((checkName) => {
      const checkRun = checksByName.get(checkName);
      return `- ${checkName}: ${checkRun?.html_url ?? checkRun?.details_url ?? "passed"}`;
    }),
  ];
  writeStepSummary(summary);
  console.log(`Required CI checks passed for ${ref}.`);
}

await main();
