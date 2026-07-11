// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off
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

type CheckRunEvaluation = {
  checksByName: Map<string, CheckRun>;
  failures: string[];
  pending: string[];
};

const DEFAULT_REQUIRED_CHECKS = [
  "Format, Lint, Typecheck, Test, Browser Test, Build",
  "Release Smoke",
];
const DEFAULT_WAIT_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 15;

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

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number of seconds.`);
  }

  return parsed;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatCheckRunStatus(checkName: string, checkRun: CheckRun | undefined): string {
  if (!checkRun) {
    return `${checkName}: missing`;
  }

  return `${checkName}: status=${checkRun.status ?? "unknown"}, conclusion=${checkRun.conclusion ?? "unknown"} (${checkRun.html_url ?? checkRun.details_url ?? "no URL"})`;
}

function evaluateRequiredChecks(
  requiredChecks: ReadonlyArray<string>,
  checkRuns: ReadonlyArray<CheckRun>,
): CheckRunEvaluation {
  const checksByName = new Map<string, CheckRun>();
  for (const checkRun of checkRuns) {
    if (checkRun.name && !checksByName.has(checkRun.name)) {
      checksByName.set(checkRun.name, checkRun);
    }
  }

  const failures: string[] = [];
  const pending: string[] = [];
  for (const checkName of requiredChecks) {
    const checkRun = checksByName.get(checkName);
    if (!checkRun || checkRun.status !== "completed") {
      pending.push(formatCheckRunStatus(checkName, checkRun));
      continue;
    }

    if (checkRun.conclusion !== "success") {
      failures.push(formatCheckRunStatus(checkName, checkRun));
    }
  }

  return { checksByName, failures, pending };
}

async function fetchRequiredGithubActionCheckRuns({
  repository,
  ref,
  requiredChecks,
  token,
}: {
  repository: string;
  ref: string;
  requiredChecks: ReadonlyArray<string>;
  token: string;
}): Promise<CheckRun[]> {
  const requiredCheckSet = new Set(requiredChecks);
  return (await fetchCheckRuns(repository, ref, token))
    .filter((run) => requiredCheckSet.has(run.name ?? ""))
    .filter((run) => !run.app?.slug || run.app.slug === "github-actions")
    .sort(compareCheckRuns);
}

async function waitForRequiredChecks({
  repository,
  ref,
  requiredChecks,
  token,
  timeoutMs,
  pollIntervalMs,
}: {
  repository: string;
  ref: string;
  requiredChecks: ReadonlyArray<string>;
  token: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<CheckRunEvaluation> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const checkRuns = await fetchRequiredGithubActionCheckRuns({
      repository,
      ref,
      requiredChecks,
      token,
    });
    const evaluation = evaluateRequiredChecks(requiredChecks, checkRuns);
    if (evaluation.failures.length > 0 || evaluation.pending.length === 0) {
      return evaluation;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return evaluation;
    }

    console.log(
      `Required CI checks still pending for ${ref}; waiting ${Math.min(pollIntervalMs, remainingMs)}ms before retry.`,
    );
    for (const pending of evaluation.pending) {
      console.log(`- ${pending}`);
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

async function main(): Promise<void> {
  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const ref = process.env.RELEASE_CI_REF ?? readRequiredEnv("GITHUB_SHA");
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN or GH_TOKEN for GitHub API access.");
  }

  const requiredChecks = readRequiredChecks();
  const evaluation = await waitForRequiredChecks({
    repository,
    ref,
    requiredChecks,
    token,
    timeoutMs:
      readNonNegativeNumberEnv("RELEASE_CI_WAIT_TIMEOUT_SECONDS", DEFAULT_WAIT_TIMEOUT_SECONDS) *
      1000,
    pollIntervalMs:
      readNonNegativeNumberEnv("RELEASE_CI_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS) *
      1000,
  });
  const failures = [...evaluation.failures, ...evaluation.pending];

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
      const checkRun = evaluation.checksByName.get(checkName);
      return `- ${checkName}: ${checkRun?.html_url ?? checkRun?.details_url ?? "passed"}`;
    }),
  ];
  writeStepSummary(summary);
  console.log(`Required CI checks passed for ${ref}.`);
}

await main();
