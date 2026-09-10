// Recreated release conversations in isolated projects. No private history is copied.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const root = path.join(
  process.env.PUBLIC || "C:/Users/Public",
  "Documents",
  "Threadlines Release Studio",
);
const marker = path.join(root, ".release-capture-owned");
if (fs.existsSync(root) && !fs.existsSync(marker))
  throw new Error("Capture directory is not owned by this kit.");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(marker, "Recreated public-safe release scenes. No real user data.\n");
const baseDir = path.join(root, ".threadlines");
const source = path.dirname(fileURLToPath(import.meta.url));
const privateProviderHomes = {
  codex: path.join(root, "provider-homes/codex"),
  claudeAgent: path.join(root, "provider-homes/claude"),
};
for (const homePath of Object.values(privateProviderHomes))
  fs.mkdirSync(homePath, { recursive: true });
fs.mkdirSync(path.join(baseDir, "dev"), { recursive: true });
fs.writeFileSync(
  path.join(baseDir, "dev/settings.json"),
  JSON.stringify(
    {
      providers: Object.fromEntries(
        Object.entries(privateProviderHomes).map(([name, homePath]) => [name, { homePath }]),
      ),
    },
    null,
    2,
  ),
);

function run(command, args, cwd = repo, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
}
function write(directory, relative, content) {
  const target = path.join(directory, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
const projectIcons = {
  Threadlines: "threadlines.ico",
  "facpmanuals-next": "facpmanuals.svg",
  "game-idea": "game-idea.ico",
  "wilfredoleon.com": "portfolio.svg",
};
const projects = Object.keys(projectIcons);
for (const name of projects) {
  const directory = path.join(root, name);
  if (fs.existsSync(path.join(directory, ".git"))) continue;
  fs.mkdirSync(directory, { recursive: true });
  const icon = projectIcons[name];
  fs.copyFileSync(path.join(source, icon), path.join(directory, `favicon${path.extname(icon)}`));
  run("git", ["init", "-b", "main"], directory);
  run("git", ["config", "user.name", "Threadlines"], directory);
  run("git", ["config", "user.email", "demo@threadlines.example"], directory);
  write(
    directory,
    "README.md",
    `# ${name}\n\nA safe capture workspace with recreated tasks. No private repository history or documents.\n`,
  );
  if (name === "Threadlines") {
    for (const relative of [
      "apps/marketing/src/pages/index.astro",
      "apps/marketing/src/lib/site.ts",
      "apps/marketing/src/layouts/Layout.astro",
    ]) {
      const currentSource = fs.readFileSync(path.join(repo, relative), "utf8");
      // The demo's first commit deliberately keeps the old headline. This
      // leaves a real local diff even after the marketing source is refreshed.
      const baselineSource =
        relative === "apps/marketing/src/pages/index.astro"
          ? currentSource.replace(
              /(<h1\b[^>]*>)[\s\S]*?(<\/h1>)/u,
              (_match, opening, closing) => `${opening}Every thread leaves a line.${closing}`,
            )
          : currentSource;
      write(directory, relative, baselineSource);
    }
    write(
      directory,
      "docs/stable-release.md",
      "# Stable release\n\nReview the homepage and download links before publishing.\n",
    );
  } else if (name === "facpmanuals-next") {
    write(
      directory,
      "docs/extraction-review.md",
      "# PDF extraction review\n\nKeep the document title useful. Preserve model identifiers that contain a slash.\n\nExample model: SS/2ZE. This is a text example, not an uploaded manual.\n",
    );
    write(
      directory,
      "docs/search-review.md",
      "# Manual search\n\nMake manufacturer and model names easy to scan. Keep the document type visible.\n",
    );
  } else if (name === "game-idea") {
    write(
      directory,
      "docs/playtest.md",
      "# Playtest notes\n\nReview idle progress and make the next upgrade easy to understand.\n",
    );
  } else {
    write(
      directory,
      "docs/portfolio-review.md",
      "# Portfolio review\n\nKeep selected work easy to scan. Explain web development services in plain language.\n",
    );
  }
  run("git", ["add", "."], directory);
  run("git", ["commit", "-m", "docs: prepare the project review"], directory);
  if (name === "Threadlines") {
    run("git", ["switch", "-c", "marketing/stable-release"], directory);
    const indexPath = "apps/marketing/src/pages/index.astro";
    const original = fs.readFileSync(path.join(directory, indexPath), "utf8");
    write(
      directory,
      indexPath,
      original
        .replace(
          "Every thread leaves a line.",
          "Run Codex and Claude. Review the work in one place.",
        )
        .replace("The 0.3 workspace:", "Your desktop workspace:"),
    );
    write(
      directory,
      "docs/stable-release.md",
      "# Stable release\n\n## Homepage\n\nLead with Codex and Claude in one desktop workspace. Show the actual app.\n\n## Launch posts\n\nStart with three posts a week. Show one useful workflow per post.\n\n## Before publishing\n\nCheck the stable downloads and review each screenshot for private details.\n",
    );
    run("git", ["add", "docs/stable-release.md"], directory);
  }
  console.log(
    run(
      process.execPath,
      [
        "apps/server/src/bin.ts",
        "project",
        "add",
        "--base-dir",
        baseDir,
        directory,
        "--title",
        name,
      ],
      repo,
      { VITE_DEV_SERVER_URL: "http://127.0.0.1:6066", THREADLINES_LOG_LEVEL: "Error" },
    ).trim(),
  );
}
// Two small graph entries and a file with stable line numbers for the context
// clip. Path-only commits keep any other staged or unstaged demo changes intact.
const historyProject = path.join(root, "Threadlines");
const historyFile = "docs/review-workflow.md";
if (!fs.existsSync(path.join(historyProject, historyFile))) {
  const firstReviewSteps =
    "# Review workflow\n\nRead the changed files beside the thread.\nCheck the pull request before merging.\n";
  write(historyProject, historyFile, firstReviewSteps);
  run("git", ["add", "--", historyFile], historyProject);
  run(
    "git",
    ["commit", "--only", "-m", "docs: explain the file and pull request review", "--", historyFile],
    historyProject,
  );
  write(
    historyProject,
    historyFile,
    firstReviewSteps +
      "Wait for checks and review comments.\nWrap up the thread when the work is done.\n",
  );
  run(
    "git",
    ["commit", "--only", "-m", "docs: finish the review workflow", "--", historyFile],
    historyProject,
  );
}
const now = Date.now();
const thread = (project, title, minutes, prompt, assistantText, provider = "codex") => ({
  title,
  branch: project === "Threadlines" ? "marketing/stable-release" : "main",
  worktreePath: path.join(root, project),
  createdAt: new Date(now - minutes * 60_000).toISOString(),
  modelSelection:
    provider === "codex"
      ? {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        }
      : {
          instanceId: "claudeAgent",
          model: "claude-fable-5.1",
          options: [{ id: "effort", value: "high" }],
        },
  scenario: { status: "idle", prompt, assistantText },
});
const seed = {
  baseDir,
  cwd: path.join(root, "Threadlines"),
  devUrl: "http://127.0.0.1:6066",
  projects: [
    {
      workspaceRoot: path.join(root, "Threadlines"),
      threads: [
        thread(
          "Threadlines",
          "Refresh the stable release page",
          4,
          "I'm getting ready to release a stable. Can you update the homepage and help me put together a few posts for X? Use real project names and keep private details out of the screenshots.",
          "The homepage draft now leads with Codex and Claude in one desktop workspace. The preview is open beside this thread.\n\nI kept the first launch post focused on the workspace. The follow-up posts can each show one thing: reviewing a pull request, adding browser context, or checking a file diff.\n\nFor the screenshots, the project names are Threadlines and facpmanuals-next. The conversations are recreated around familiar work. No private PDFs, account details, or production data are included.\n\nNext, review the headline in the browser and the two changed files in Source Control. The release date is still open.",
        ),
        thread(
          "Threadlines",
          "Review the pull request workflow",
          65,
          "Walk through the PR view before the stable release. I want to be able to read a review comment and send it back to the right thread.",
          "I'll check the path from the PR list to the diff, then from a review comment back to its thread. I'll also check how failed checks and merge queue state appear beside the composer.",
          "claude",
        ),
        thread(
          "Threadlines",
          "Fix Windows first-run setup",
          150,
          "Make it clear what a new Windows user needs to install and where to sign in.",
          "The setup review covers Git, GitHub, Codex, and Claude. Each missing tool needs a visible action, and the app should refresh its status after installation.",
        ),
        thread(
          "Threadlines",
          "Keep model labels visible on mobile",
          1500,
          "The composer is tight on a narrow screen. Keep the model and reasoning labels readable.",
          "I'll review the compact controls at a narrow width and check for overlap. Model and reasoning labels should remain visible before the less frequently used controls.",
          "claude",
        ),
      ],
    },
    {
      workspaceRoot: path.join(root, "facpmanuals-next"),
      threads: [
        thread(
          "facpmanuals-next",
          "Fix PDF titles and model numbers",
          22,
          "The extracted title should describe the manual. Also check that a model like SS/2ZE stays together instead of splitting at the slash.",
          "I'll check the final title and model normalization together. The slash can be part of a model identifier, so splitting every slash would lose information.\n\nThe capture workspace uses a text example only. No private manual needs to be uploaded or reprocessed for this review.",
          "claude",
        ),
        thread(
          "facpmanuals-next",
          "Review the manual search page",
          220,
          "Make the search results easier to scan. Manufacturer, model, and document type should be clear.",
          "I'll look at the result rows with short and long model names, then check the same layout on mobile. The document type should stay visible without crowding the title.",
        ),
      ],
    },
    {
      workspaceRoot: path.join(root, "game-idea"),
      threads: [
        thread(
          "game-idea",
          "Balance idle progress",
          12,
          "The first few upgrades should feel useful. Review the early idle progress without making the player wait too long.",
          "I'll compare the first upgrade costs with the starting income rate. Then I'll check whether the next useful action is clear from the main screen.",
          "claude",
        ),
        thread(
          "game-idea",
          "Polish the upgrade menu",
          125,
          "Make the upgrade menu easier to read. Keep cost and benefit next to each other.",
          "I'll keep each upgrade in one compact row, with its cost and effect visible together. Unavailable upgrades should explain what is missing.",
        ),
      ],
    },
    {
      workspaceRoot: path.join(root, "wilfredoleon.com"),
      threads: [
        thread(
          "wilfredoleon.com",
          "Refresh the selected work section",
          32,
          "Make the portfolio projects easier to scan, especially on a phone. Keep the descriptions short.",
          "I'll lead each project with its name and one sentence about the work. On mobile, the image and project link should stay close together.",
        ),
        thread(
          "wilfredoleon.com",
          "Clarify the web development services",
          180,
          "Explain what someone can hire me to build without making the page sound like an agency brochure.",
          "I'll use plain descriptions of the work and make the next step clear. The services section should answer what you build and how someone can get in touch.",
          "claude",
        ),
      ],
    },
  ],
};
const input = path.join(root, "release-threads.json");
fs.writeFileSync(input, JSON.stringify(seed, null, 2));
console.log(run(process.execPath, ["apps/server/src/cli/marketingStudioSeed.ts", input]));
console.log(`Capture root: ${root}`);
