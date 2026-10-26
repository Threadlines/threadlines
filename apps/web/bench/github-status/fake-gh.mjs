// A stand-in for the GitHub CLI (`gh`) that the GitHub status benchmark puts on
// the server's PATH. It answers the requests the server really makes (see
// apps/server/src/sourceControl/GitHubCli.ts, GitHubSourceControlProvider.ts,
// gitHubMergeQueue.ts and apps/server/src/pullRequest/GitHubPullRequestProvider.ts)
// from a scripted state file the benchmark rewrites, and logs every call.
//
//   FAKE_GH_STATE=<state.json> FAKE_GH_LOG=<calls.jsonl> node fake-gh.mjs <gh args>
//
// Anything it does not recognise is logged with kind "UNKNOWN" and exits 64, so
// a request the server starts making later shows up instead of being answered
// with empty JSON. That includes a GraphQL document that differs in any way
// from the server's own (pinned below), and an unknown `--json` field.
//
// Each call writes a "start" line when it begins and an "end" line (with its
// kind and exit code) when it answers, so a reader can tell a call in flight.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const startedAt = Date.now();
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const logPath = process.env.FAKE_GH_LOG;
const latencyMs = Number(process.env.FAKE_GH_LATENCY_MS ?? 0);
const callId = `${process.pid}-${startedAt}`;

class Unsupported extends Error {}

/** A request gh itself would refuse: logged under its kind, exits 1 like gh does. */
class GhFailure extends Error {}

const log = {
  kind: "UNKNOWN",
  repo: null,
  note: null,
};

const shortArgs = () => args.map((arg) => (arg.length > 120 ? `${arg.slice(0, 117)}...` : arg));

function appendLog(line) {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`);
}

appendLog({ phase: "start", id: callId, t: startedAt, args: shortArgs(), cwd: process.cwd() });

function writeLog(exit, extra = {}) {
  appendLog({
    phase: "end",
    id: callId,
    t: startedAt,
    kind: log.kind,
    repo: log.repo,
    note: log.note,
    args: shortArgs(),
    cwd: process.cwd(),
    durMs: Date.now() - startedAt,
    exit,
    ...extra,
  });
}

/**
 * The GraphQL documents the server sends, whitespace collapsed, as of the
 * commit this benchmark was written against. The server builds them in
 * apps/server/src/pullRequest/gitHubPullRequestGraphql.ts, gitHubAvatar.ts and
 * apps/server/src/sourceControl/gitHubMergeQueue.ts. A document that changes
 * there stops matching here and fails loudly: update the copy and the answer
 * together, so the fake never answers fields nobody asked for or leaves out
 * new ones.
 */
const REACTION_GROUPS = "reactionGroups { content viewerHasReacted users { totalCount } }";
const DOCUMENTS = {
  "gql:merge-queue-nodes":
    "query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { id isInMergeQueue autoMergeRequest { enabledAt } } } }",
  "gql:avatar-nodes":
    "query($ids: [ID!]!) { nodes(ids: $ids) { ... on User { login avatarUrl } ... on Bot { login avatarUrl } } }",
  "gql:authored-search":
    "query($q: String!, $first: Int!) { search(query: $q, type: ISSUE, first: $first) { nodes { ... on PullRequest { number title url isDraft state mergedAt createdAt updatedAt headRefName baseRefName additions deletions mergeable reviewDecision autoMergeRequest { enabledAt } isInMergeQueue author { login avatarUrl } repository { nameWithOwner viewerPermission } labels(first: 20) { nodes { name color } } reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }",
  "gql:base-state":
    "query($owner: String!, $name: String!, $number: Int!, $headRef: String!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { baseRef { compare(headRef: $headRef) { behindBy } } isMergeQueueEnabled isInMergeQueue mergeQueueEntry { position } timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { __typename ... on RemovedFromMergeQueueEvent { id createdAt reason beforeCommit { statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state description targetUrl } } } } } } } } } } }",
  "gql:conversation": `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${REACTION_GROUPS} reviewThreads(first: 100) { nodes { id isResolved isOutdated path line diffSide comments(first: 100) { nodes { id author { login avatarUrl } body createdAt url viewerDidAuthor ${REACTION_GROUPS} } } } } comments(first: 100) { nodes { id viewerDidAuthor author { login avatarUrl } ${REACTION_GROUPS} } } reviews(first: 100) { nodes { id viewerDidAuthor author { login avatarUrl } ${REACTION_GROUPS} } } } } }`,
  "gql:auto-merge-readiness":
    "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { mergeStateStatus isMergeQueueEnabled } } }",
  "gql:queue-standing":
    "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id isInMergeQueue } } }",
};
const LOOKUP_FIELDS =
  "fragment LookupFields on PullRequest { number title url state isDraft headRefName baseRefName additions deletions createdAt updatedAt mergedAt closedAt isCrossRepository isInMergeQueue autoMergeRequest { enabledAt } }";

/** The lookup document for these variables, as `gitHubPullRequestLookupRequest` builds it. */
function lookupDocument(variables) {
  const numbers = Object.keys(variables).filter((key) => /^n\d+$/u.test(key));
  const branches = Object.keys(variables).filter((key) => /^b\d+$/u.test(key));
  const declarations = ["$owner: String!", "$name: String!"];
  const selections = ["defaultBranchRef { name }"];
  numbers.forEach((_, index) => {
    declarations.push(`$n${index}: Int!`);
    selections.push(`n${index}: pullRequest(number: $n${index}) { ...LookupFields }`);
  });
  const candidates = (alias, index, states) =>
    `${alias}${index}: pullRequests(headRefName: $b${index}, states: [${states}], first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { pageInfo { hasNextPage } nodes { ...LookupFields } }`;
  branches.forEach((_, index) => {
    declarations.push(`$b${index}: String!`);
    selections.push(candidates("bo", index, "OPEN"), candidates("bs", index, "MERGED, CLOSED"));
  });
  return `query(${declarations.join(", ")}) { repository(owner: $owner, name: $name) { ${selections.join(" ")} } } ${LOOKUP_FIELDS}`;
}

const collapse = (text) => text.replace(/\s+/gu, " ").trim();

/** Which pinned document this is, or null. */
function documentKind(query, variables) {
  const text = collapse(query);
  for (const [kind, document] of Object.entries(DOCUMENTS)) {
    if (text === document) return kind;
  }
  if (text.includes("fragment LookupFields") && text === lookupDocument(variables)) {
    return "gql:lookup";
  }
  return null;
}

function readState() {
  if (!statePath) throw new Unsupported("FAKE_GH_STATE is not set");
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls `--name value` (and `--name=value`) flags out of an argv tail. */
function parseFlags(list, { booleans = [] } = {}) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length === 2)) {
      const eq = arg.indexOf("=");
      const name = (eq > 0 ? arg.slice(0, eq) : arg).replace(/^-+/u, "");
      if (booleans.includes(name)) {
        flags[name] = true;
        continue;
      }
      const value = eq > 0 ? arg.slice(eq + 1) : list[(index += 1)];
      if (value === undefined) throw new Unsupported(`flag ${arg} has no value`);
      if (flags[name] !== undefined) {
        flags[name] = [flags[name], value].flat();
      } else {
        flags[name] = value;
      }
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

function only(flags, allowed, where) {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) throw new Unsupported(`${where}: unexpected flag --${name}`);
  }
}

function parseRepoSlug(text) {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(text.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The repository a command without `--repo` talks about: the checkout's origin. */
function repoFromCwd() {
  let url = "";
  try {
    url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new GhFailure("failed to determine base repo: no git remotes found");
  }
  const slug = parseRepoSlug(url);
  if (!slug) throw new GhFailure(`none of the git remotes point to a known GitHub host: ${url}`);
  return slug;
}

function repoState(state, slug) {
  const repo = state.repos?.[slug] ?? state.repos?.[slug.toLowerCase()];
  if (!repo) {
    throw new GhFailure(`GraphQL: Could not resolve to a Repository with the name '${slug}'.`);
  }
  return repo;
}

const nodeId = (slug, number) => `PR_${slug.replace(/[^A-Za-z0-9]/gu, "_")}_${number}`;
const prUrl = (slug, number) => `https://github.com/${slug}/pull/${number}`;
const ghState = (pr) => (pr.state ?? "OPEN").toUpperCase();
const checkName = "ci/test";

function rollupNodes(slug, pr) {
  const checks = pr.checks ?? "none";
  if (checks === "none") return [];
  const detailsUrl = `https://github.com/${slug}/actions/runs/${pr.number}`;
  if (checks === "pending") {
    return [
      {
        __typename: "CheckRun",
        name: checkName,
        status: "IN_PROGRESS",
        conclusion: "",
        detailsUrl,
        startedAt: pr.updatedAt,
        completedAt: "0001-01-01T00:00:00Z",
        workflowName: "CI",
      },
    ];
  }
  return [
    {
      __typename: "CheckRun",
      name: checkName,
      status: "COMPLETED",
      conclusion: checks === "failure" ? "FAILURE" : "SUCCESS",
      detailsUrl,
      startedAt: pr.updatedAt,
      completedAt: pr.updatedAt,
      workflowName: "CI",
    },
  ];
}

function rollupState(pr) {
  switch (pr.checks ?? "none") {
    case "pending":
      return "PENDING";
    case "success":
      return "SUCCESS";
    case "failure":
      return "FAILURE";
    default:
      return null;
  }
}

const autoMergeRequest = (pr) =>
  pr.autoMerge || pr.inMergeQueue
    ? { enabledAt: pr.updatedAt, mergeMethod: "SQUASH", enabledBy: { login: "bench-user" } }
    : null;

/** Every `--json` field the server asks `gh pr list` / `gh pr view` for. */
function prJsonField(state, slug, pr, field) {
  const [owner] = slug.split("/");
  const name = slug.split("/")[1];
  switch (field) {
    case "id":
      return nodeId(slug, pr.number);
    case "number":
      return pr.number;
    case "title":
      return pr.title;
    case "url":
      return prUrl(slug, pr.number);
    case "author":
      return { id: "U_bench", login: state.viewer, name: "Bench User", is_bot: false };
    case "headRefName":
      return pr.headRefName;
    case "baseRefName":
      return pr.baseRefName ?? "main";
    case "state":
      return ghState(pr);
    case "isDraft":
      return pr.isDraft === true;
    case "additions":
      return pr.additions ?? 10;
    case "deletions":
      return pr.deletions ?? 2;
    case "createdAt":
      return pr.createdAt;
    case "updatedAt":
      return pr.updatedAt;
    case "mergedAt":
      return ghState(pr) === "MERGED" ? (pr.mergedAt ?? pr.updatedAt) : null;
    case "closedAt":
      return ghState(pr) === "OPEN" ? null : (pr.closedAt ?? pr.updatedAt);
    case "mergeable":
      return ghState(pr) === "OPEN" ? "MERGEABLE" : "UNKNOWN";
    case "reviewDecision":
      return "";
    case "reviewRequests":
      return [];
    case "labels":
      return [];
    case "autoMergeRequest":
      return autoMergeRequest(pr);
    case "statusCheckRollup":
      return rollupNodes(slug, pr);
    case "isCrossRepository":
      return false;
    case "headRepository":
      return { id: `R_${owner}_${name}`, name, nameWithOwner: slug };
    case "headRepositoryOwner":
      return { id: `O_${owner}`, login: owner, name: owner };
    case "body":
      return pr.body ?? "Benchmark pull request.";
    case "changedFiles":
      return 1;
    case "reviews":
      return [];
    case "comments":
      return [];
    case "commits":
      return [
        {
          oid: pr.headSha,
          messageHeadline: pr.title,
          committedDate: pr.updatedAt,
          authors: [{ login: state.viewer }],
        },
      ];
    case "mergeStateStatus":
      if (ghState(pr) !== "OPEN") return "UNKNOWN";
      if (pr.isDraft) return "DRAFT";
      return pr.checks === "pending" ? "BLOCKED" : pr.checks === "failure" ? "UNSTABLE" : "CLEAN";
    case "headRefOid":
      return pr.headSha;
    default:
      throw new Unsupported(`unknown --json field ${field}`);
  }
}

const JSON_FIELDS = new Set(
  "id number title url author headRefName baseRefName state isDraft additions deletions createdAt updatedAt mergedAt closedAt mergeable reviewDecision reviewRequests labels autoMergeRequest statusCheckRollup isCrossRepository headRepository headRepositoryOwner body changedFiles reviews comments commits mergeStateStatus headRefOid".split(
    " ",
  ),
);

/** A `--json` list, every field checked before anything is answered. */
function jsonFields(text) {
  const fields = text.split(",");
  for (const field of fields) {
    if (!JSON_FIELDS.has(field)) throw new Unsupported(`unknown --json field ${field}`);
  }
  return fields;
}

function prJson(state, slug, pr, fields) {
  return Object.fromEntries(fields.map((field) => [field, prJsonField(state, slug, pr, field)]));
}

const byNewest = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

function matchesState(pr, wanted) {
  const value = ghState(pr);
  switch (wanted) {
    case "open":
      return value === "OPEN";
    case "closed":
      return value === "CLOSED";
    case "merged":
      return value === "MERGED";
    case "all":
      return true;
    default:
      throw new Unsupported(`pr list --state ${wanted}`);
  }
}

function prListKind(flags) {
  if (flags.head) return `pr-list-head:${flags.state ?? "open"}`;
  if (flags.json === "title,body,author") return "pr-list-samples";
  return `pr-list-repo:${flags.state ?? "open"}`;
}

function runPrList(state, rest) {
  const { flags, positional } = parseFlags(rest);
  only(flags, ["repo", "head", "state", "limit", "json"], "pr list");
  if (positional.length > 0) throw new Unsupported(`pr list positional ${positional.join(" ")}`);
  if (!flags.json) throw new Unsupported("pr list without --json");
  log.kind = prListKind(flags);
  const fields = jsonFields(flags.json);
  const slug = flags.repo ?? repoFromCwd();
  log.repo = slug;
  const repo = repoState(state, slug);
  const limit = Number(flags.limit ?? 30);
  let head = null;
  if (flags.head) {
    const [maybeOwner, maybeBranch] = flags.head.includes(":")
      ? flags.head.split(":")
      : [null, flags.head];
    if (maybeOwner !== null && maybeOwner.toLowerCase() !== slug.split("/")[0].toLowerCase()) {
      return "[]";
    }
    head = maybeBranch;
  }
  const rows = (repo.pulls ?? [])
    .filter((pr) => matchesState(pr, flags.state ?? "open"))
    .filter((pr) => head === null || pr.headRefName === head)
    .toSorted(byNewest)
    .slice(0, limit);
  return JSON.stringify(rows.map((pr) => prJson(state, slug, pr, fields)));
}

function findPullRequest(state, slug, reference) {
  const repo = repoState(state, slug);
  if (/^\d+$/u.test(reference)) {
    const pr = (repo.pulls ?? []).find((entry) => entry.number === Number(reference));
    if (!pr) {
      throw new GhFailure(
        `GraphQL: Could not resolve to a PullRequest with the number of ${reference}. (repository.pullRequest)`,
      );
    }
    return pr;
  }
  const pr = (repo.pulls ?? [])
    .filter((entry) => entry.headRefName === reference)
    .toSorted(byNewest)
    .find((entry) => ghState(entry) === "OPEN");
  if (!pr) throw new GhFailure(`no pull requests found for branch "${reference}"`);
  return pr;
}

function runPrView(state, rest) {
  const { flags, positional } = parseFlags(rest);
  only(flags, ["repo", "json"], "pr view");
  if (!flags.json) throw new Unsupported("pr view without --json");
  const fields = jsonFields(flags.json);
  log.kind = fields.includes("headRefOid")
    ? "pr-view:detail"
    : fields.includes("commits")
      ? "pr-view:activity"
      : "pr-view:summary";
  let reference = positional[0];
  if (positional.length !== 1) throw new Unsupported("pr view needs one reference");
  let slug = flags.repo ?? null;
  const urlMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/u.exec(reference);
  if (urlMatch) {
    slug = urlMatch[1];
    reference = urlMatch[2];
  }
  slug ??= repoFromCwd();
  log.repo = slug;
  log.note = `#${reference}`;
  return JSON.stringify(prJson(state, slug, findPullRequest(state, slug, reference), fields));
}

function runRepoView(state, rest) {
  const { flags, positional } = parseFlags(rest);
  only(flags, ["json", "jq"], "repo view");
  const slug = positional[0] ?? repoFromCwd();
  log.repo = slug;
  const repo = repoState(state, slug);
  if (flags.json === "defaultBranchRef" && flags.jq === ".defaultBranchRef.name") {
    log.kind = "repo-view:default-branch";
    return repo.defaultBranch ?? "main";
  }
  if (flags.json === "nameWithOwner,url,sshUrl" && flags.jq === undefined) {
    log.kind = "repo-view:clone-urls";
    return JSON.stringify({
      nameWithOwner: slug,
      url: `https://github.com/${slug}`,
      sshUrl: `git@github.com:${slug}.git`,
    });
  }
  throw new Unsupported(`repo view --json ${flags.json} --jq ${flags.jq}`);
}

function repositoryRecord(slug, repo) {
  return {
    full_name: slug,
    html_url: `https://github.com/${slug}`,
    ssh_url: `git@github.com:${slug}.git`,
    archived: false,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    allow_auto_merge: true,
    default_branch: repo.defaultBranch ?? "main",
  };
}

function lookupNode(state, slug, pr) {
  return {
    number: pr.number,
    title: pr.title,
    url: prUrl(slug, pr.number),
    state: ghState(pr),
    isDraft: pr.isDraft === true,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName ?? "main",
    additions: pr.additions ?? 10,
    deletions: pr.deletions ?? 2,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: prJsonField(state, slug, pr, "mergedAt"),
    closedAt: prJsonField(state, slug, pr, "closedAt"),
    isCrossRepository: false,
    isInMergeQueue: pr.inMergeQueue === true,
    autoMergeRequest: autoMergeRequest(pr),
  };
}

function allPullRequests(state) {
  return Object.entries(state.repos ?? {}).flatMap(([slug, repo]) =>
    (repo.pulls ?? []).map((pr) => ({ slug, pr })),
  );
}

/** `gh api graphql --input -`: one JSON body with the document and its variables. */
function runGraphql(state, body) {
  const { query, variables = {} } = body;
  if (typeof query !== "string") throw new Unsupported("graphql body without a query");

  const kind = documentKind(query, variables);
  if (kind === null) {
    throw new Unsupported(`graphql document: ${collapse(query).slice(0, 200)}`);
  }
  log.kind = kind;

  if (kind === "gql:merge-queue-nodes") {
    const byId = new Map(
      allPullRequests(state).map(({ slug, pr }) => [nodeId(slug, pr.number), pr]),
    );
    log.note = `ids=${variables.ids?.length ?? 0}`;
    return {
      data: {
        nodes: (variables.ids ?? []).map((id) => {
          const pr = byId.get(id);
          return pr
            ? {
                id,
                isInMergeQueue: pr.inMergeQueue === true,
                autoMergeRequest: autoMergeRequest(pr),
              }
            : null;
        }),
      },
    };
  }

  if (kind === "gql:avatar-nodes") {
    return {
      data: {
        nodes: (variables.ids ?? []).map(() => ({
          login: state.viewer,
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        })),
      },
    };
  }

  if (kind === "gql:authored-search") {
    const q = String(variables.q ?? "");
    log.note = q;
    const author = /author:(\S+)/u.exec(q)?.[1];
    const wanted = q.includes("is:open")
      ? "OPEN"
      : q.includes("is:merged")
        ? "MERGED"
        : q.includes("is:closed")
          ? "CLOSED"
          : null;
    if (!q.includes("is:pr") || author === undefined || wanted === null) {
      throw new Unsupported(`authored search ${q}`);
    }
    const nodes = allPullRequests(state)
      .filter(({ pr }) => author === state.viewer && ghState(pr) === wanted)
      .toSorted((a, b) => byNewest(a.pr, b.pr))
      .slice(0, Number(variables.first ?? 30))
      .map(({ slug, pr }) => ({
        ...lookupNode(state, slug, pr),
        mergeable: prJsonField(state, slug, pr, "mergeable"),
        reviewDecision: null,
        author: { login: state.viewer, avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
        repository: { nameWithOwner: slug, viewerPermission: "ADMIN" },
        labels: { nodes: [] },
        reviewRequests: { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: rollupState(pr) === null ? null : { state: rollupState(pr) },
              },
            },
          ],
        },
      }));
    return { data: { search: { nodes } } };
  }

  const slug = variables.owner && variables.name ? `${variables.owner}/${variables.name}` : null;
  if (slug === null) throw new Unsupported("graphql document without owner/name or ids");
  log.repo = slug;
  const repo = repoState(state, slug);
  const pulls = repo.pulls ?? [];
  const pullRequestByNumber = (number) => {
    const pr = pulls.find((entry) => entry.number === number);
    if (!pr) {
      throw new GhFailure(
        `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`,
      );
    }
    return pr;
  };

  if (kind === "gql:lookup") {
    const numbers = Object.keys(variables).filter((key) => /^n\d+$/u.test(key));
    const branches = Object.keys(variables).filter((key) => /^b\d+$/u.test(key));
    log.note = `numbers=${numbers.length} branches=${branches.length}`;
    const repository = { defaultBranchRef: { name: repo.defaultBranch ?? "main" } };
    for (const key of numbers) {
      const pr = pulls.find((entry) => entry.number === variables[key]);
      if (!pr) {
        throw new GhFailure(
          `GraphQL: Could not resolve to a PullRequest with the number of ${variables[key]}. (repository.${key})`,
        );
      }
      repository[key] = lookupNode(state, slug, pr);
    }
    for (const key of branches) {
      const index = key.slice(1);
      const candidates = (states) => {
        const rows = pulls
          .filter((pr) => pr.headRefName === variables[key] && states.includes(ghState(pr)))
          .toSorted(byNewest);
        return {
          pageInfo: { hasNextPage: rows.length > 10 },
          nodes: rows.slice(0, 10).map((pr) => lookupNode(state, slug, pr)),
        };
      };
      repository[`bo${index}`] = candidates(["OPEN"]);
      repository[`bs${index}`] = candidates(["MERGED", "CLOSED"]);
    }
    return { data: { repository } };
  }

  if (kind === "gql:base-state") {
    const pr = pullRequestByNumber(variables.number);
    log.note = `#${pr.number}`;
    return {
      data: {
        repository: {
          pullRequest: {
            baseRef: { compare: { behindBy: pr.behindBy ?? 0 } },
            isMergeQueueEnabled: repo.mergeQueue === true,
            isInMergeQueue: pr.inMergeQueue === true,
            mergeQueueEntry: pr.inMergeQueue ? { position: 1 } : null,
            timelineItems: { nodes: [] },
          },
        },
      },
    };
  }

  if (kind === "gql:conversation") {
    pullRequestByNumber(variables.number);
    return {
      data: {
        repository: {
          pullRequest: {
            reactionGroups: [],
            reviewThreads: { nodes: [] },
            comments: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      },
    };
  }

  if (kind === "gql:auto-merge-readiness") {
    const pr = pullRequestByNumber(variables.number);
    return {
      data: {
        repository: {
          pullRequest: {
            mergeStateStatus: prJsonField(state, slug, pr, "mergeStateStatus"),
            isMergeQueueEnabled: repo.mergeQueue === true,
          },
        },
      },
    };
  }

  if (kind === "gql:queue-standing") {
    const pr = pullRequestByNumber(variables.number);
    return {
      data: {
        repository: {
          pullRequest: { id: nodeId(slug, pr.number), isInMergeQueue: pr.inMergeQueue === true },
        },
      },
    };
  }

  throw new Unsupported(`graphql document kind ${kind} has no answer`);
}

function runApi(state, rest) {
  const { flags, positional } = parseFlags(rest);
  const endpoint = positional[0];
  if (endpoint === "graphql") {
    only(flags, ["input", "hostname", "f", "F", "field", "raw-field"], "api graphql");
    let body;
    if (flags.input === "-") {
      const stdin = readStdin();
      try {
        body = JSON.parse(stdin);
      } catch {
        throw new Unsupported(`api graphql stdin is not JSON: ${stdin.slice(0, 120)}`);
      }
    } else {
      const fieldsOf = (value) => (value === undefined ? [] : [value].flat());
      const raw = [...fieldsOf(flags.f), ...fieldsOf(flags["raw-field"])];
      const typed = [...fieldsOf(flags.F), ...fieldsOf(flags.field)];
      body = { query: undefined, variables: {} };
      for (const entry of raw) {
        const [key, ...value] = entry.split("=");
        if (key === "query") body.query = value.join("=");
        else body.variables[key] = value.join("=");
      }
      for (const entry of typed) {
        const [key, ...value] = entry.split("=");
        const text = value.join("=");
        body.variables[key] = /^\d+$/u.test(text) ? Number(text) : text;
      }
    }
    if (flags.hostname !== undefined && flags.hostname !== "github.com") {
      throw new Unsupported(`api graphql --hostname ${flags.hostname}`);
    }
    return JSON.stringify(runGraphql(state, body));
  }
  only(flags, ["jq", "method", "X", "input"], "api");
  if (flags.method !== undefined || flags.X !== undefined || flags.input !== undefined) {
    throw new Unsupported(`api write ${rest.join(" ")}`);
  }
  if (endpoint === "user") {
    log.kind = "api-user";
    const user = { login: state.viewer, id: 1, name: "Bench User", type: "User" };
    if (flags.jq === ".login") return state.viewer;
    if (flags.jq === undefined) return JSON.stringify(user);
    throw new Unsupported(`api user --jq ${flags.jq}`);
  }
  if (endpoint?.startsWith("user/repos")) {
    log.kind = "api-user-repos";
    return "[]";
  }
  const repoMatch = /^repos\/([^/]+\/[^/?]+)$/u.exec(endpoint ?? "");
  if (repoMatch) {
    const slug = repoMatch[1];
    log.repo = slug;
    const repo = repoState(state, slug);
    if (flags.jq === ".default_branch") {
      log.kind = "api-repo:default-branch";
      return repo.defaultBranch ?? "main";
    }
    if (flags.jq === undefined) {
      log.kind = "api-repo";
      return JSON.stringify(repositoryRecord(slug, repo));
    }
    throw new Unsupported(`api ${endpoint} --jq ${flags.jq}`);
  }
  throw new Unsupported(`api ${endpoint}`);
}

async function run() {
  const [command, subcommand, ...rest] = args;
  if (command === "--version" || command === "version") {
    log.kind = "version";
    return "gh version 99.0.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v99.0.0";
  }
  const state = readState();
  if (latencyMs > 0) await sleep(latencyMs);
  if (command === "auth" && subcommand === "status") {
    const { flags } = parseFlags(rest);
    only(flags, ["json", "hostname"], "auth status");
    if (flags.json !== "hosts") throw new Unsupported("auth status without --json hosts");
    log.kind = "auth-status";
    return JSON.stringify({
      hosts: {
        "github.com": [
          {
            state: "success",
            active: true,
            host: "github.com",
            login: state.viewer,
            tokenSource: "keyring",
            scopes: "gist, read:org, repo, workflow",
            gitProtocol: "https",
          },
        ],
      },
    });
  }
  if (command === "pr" && subcommand === "list") return runPrList(state, rest);
  if (command === "pr" && subcommand === "view") return runPrView(state, rest);
  if (command === "repo" && subcommand === "view") return runRepoView(state, rest);
  if (command === "api")
    return runApi(
      state,
      [subcommand, ...rest].filter((arg) => arg !== undefined),
    );
  throw new Unsupported(`gh ${args.join(" ")}`);
}

try {
  const output = await run();
  process.stdout.write(`${output}\n`);
  writeLog(0);
  process.exit(0);
} catch (error) {
  if (error instanceof GhFailure) {
    process.stderr.write(`${error.message}\n`);
    writeLog(1, { error: error.message });
    process.exit(1);
  }
  log.kind = "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fake gh: unsupported request (${message}): gh ${args.join(" ")}\n`);
  writeLog(64, { error: message });
  process.exit(64);
}
