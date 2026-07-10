#!/usr/bin/env node

const args = process.argv.slice(2);

const argumentValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const mergedPullRequests = {
  "feature/usage-insights": {
    number: 84,
    title: "Roll out usage insights",
    repository: "threadlines-labs/orbit-demo",
  },
  "studio/alert-grouping": {
    number: 41,
    title: "Group noisy deploy alerts",
    repository: "threadlines-labs/northstar-demo",
  },
  "studio/evaluation-cache": {
    number: 27,
    title: "Cache flag evaluations",
    repository: "threadlines-labs/lumen-demo",
  },
};

const findPullRequest = (headSelector) =>
  Object.entries(mergedPullRequests).find(
    ([branch]) => headSelector === branch || headSelector.endsWith(`:${branch}`),
  );

if (args.includes("--version")) {
  console.log("gh version 2.77.0 (Threadlines Marketing Studio)");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  console.log(
    JSON.stringify({
      hosts: {
        "github.com": [
          {
            state: "success",
            active: true,
            host: "github.com",
            login: "maya-chen",
          },
        ],
      },
    }),
  );
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  const headSelector = argumentValue("--head") ?? "";
  const state = argumentValue("--state") ?? "open";
  const match = findPullRequest(headSelector);
  if (!match || state === "open") {
    console.log("[]");
    process.exit(0);
  }

  const [branch, pullRequest] = match;
  console.log(
    JSON.stringify([
      {
        number: pullRequest.number,
        title: pullRequest.title,
        url: `https://github.com/${pullRequest.repository}/pull/${pullRequest.number}`,
        baseRefName: "main",
        headRefName: branch,
        state: "MERGED",
        mergedAt: "2026-07-08T16:20:00.000Z",
        updatedAt: "2026-07-08T16:20:00.000Z",
        isCrossRepository: false,
        headRepository: { nameWithOwner: pullRequest.repository },
        headRepositoryOwner: { login: "threadlines-labs" },
      },
    ]),
  );
  process.exit(0);
}

if (args[0] === "repo" && args[1] === "view") {
  const repository = args[2] ?? "threadlines-labs/orbit-demo";
  console.log(
    JSON.stringify({
      nameWithOwner: repository,
      url: `https://github.com/${repository}`,
      sshUrl: `git@github.com:${repository}.git`,
    }),
  );
  process.exit(0);
}

console.log("[]");
