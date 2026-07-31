#!/usr/bin/env node
// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off

import * as ChildProcess from "node:child_process";
import * as FileSystem from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveMarketingStudioRoot } from "./lib/marketing-studio-paths.ts";

const STUDIO_KIND = "threadlines-marketing-studio";
const APP_DATA_KIND = "threadlines-marketing-studio-app-data";
const STUDIO_VERSION = 1;
const THREAD_SEED_VERSION = 6;
const MARKETING_CAPTURE_DEBUG_PORT = "9223";
const PROJECT_NAME = "Orbit";
const USER_DATA_DIR_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const REPO_ROOT = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");

interface StudioPaths {
  readonly root: string;
  readonly metadata: string;
  readonly projectSeedMarker: string;
  readonly threadSeedMarker: string;
  readonly threadSeedInput: string;
  readonly project: string;
  readonly lumenProject: string;
  readonly northstarProject: string;
  readonly fixtureBin: string;
  readonly worktrees: string;
  readonly remoteRepository: string;
  readonly lumenRemoteRepository: string;
  readonly northstarRemoteRepository: string;
  readonly threadlinesHome: string;
  readonly windowState: string;
  readonly appData: string;
  readonly appDataMetadata: string;
  readonly captureMasters: string;
  readonly captureExports: string;
  readonly capturePosters: string;
  readonly capturePlan: string;
}

interface StudioMetadata {
  readonly kind: typeof STUDIO_KIND;
  readonly version: typeof STUDIO_VERSION;
  readonly project: typeof PROJECT_NAME;
}

const lines = (...values: ReadonlyArray<string>): string => values.join("\n") + "\n";

const resolveDefaultAppDataRoot = (): string => {
  if (process.platform === "darwin") {
    return NodePath.join(
      NodeOS.homedir(),
      "Library",
      "Application Support",
      "threadlines-marketing-studio",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return NodePath.join(
      appData && appData.length > 0
        ? appData
        : NodePath.join(NodeOS.homedir(), "AppData", "Roaming"),
      "threadlines-marketing-studio",
    );
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return NodePath.join(
    xdgConfigHome && xdgConfigHome.length > 0
      ? xdgConfigHome
      : NodePath.join(NodeOS.homedir(), ".config"),
    "threadlines-marketing-studio",
  );
};

const resolveStudioPaths = (): StudioPaths => {
  const configuredRoot = process.env.THREADLINES_MARKETING_STUDIO_DIR?.trim();
  const configuredAppData = process.env.THREADLINES_MARKETING_STUDIO_APP_DATA_DIR?.trim();
  const root = resolveMarketingStudioRoot({
    configuredRoot,
    homeDirectory: NodeOS.homedir(),
    publicDirectory: process.env.PUBLIC?.trim(),
  });
  const captures = NodePath.join(root, "Captures");
  const appData = NodePath.resolve(
    configuredAppData && configuredAppData.length > 0
      ? configuredAppData
      : resolveDefaultAppDataRoot(),
  );

  return {
    root,
    metadata: NodePath.join(root, ".threadlines-marketing-studio.json"),
    projectSeedMarker: NodePath.join(root, ".threadlines-marketing-projects-seeded"),
    threadSeedMarker: NodePath.join(root, ".threadlines-marketing-threads-seeded"),
    threadSeedInput: NodePath.join(root, ".threadlines-marketing-thread-seed.json"),
    project: NodePath.join(root, PROJECT_NAME),
    lumenProject: NodePath.join(root, "Lumen"),
    northstarProject: NodePath.join(root, "Northstar"),
    fixtureBin: NodePath.join(root, ".bin"),
    worktrees: NodePath.join(root, ".worktrees"),
    remoteRepository: NodePath.join(root, ".remote", "orbit-demo.git"),
    lumenRemoteRepository: NodePath.join(root, ".remote", "lumen-demo.git"),
    northstarRemoteRepository: NodePath.join(root, ".remote", "northstar-demo.git"),
    threadlinesHome: NodePath.join(root, ".threadlines"),
    windowState: NodePath.join(root, ".threadlines", "dev", "window-state.json"),
    appData,
    appDataMetadata: NodePath.join(appData, ".threadlines-marketing-studio.json"),
    captureMasters: NodePath.join(captures, "Masters"),
    captureExports: NodePath.join(captures, "Exports"),
    capturePosters: NodePath.join(captures, "Posters"),
    capturePlan: NodePath.join(root, "Capture Plan.json"),
  };
};

const paths = resolveStudioPaths();

const writeTextFile = (filePath: string, contents: string): void => {
  FileSystem.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  FileSystem.writeFileSync(filePath, contents, "utf8");
};

const writeProjectFile = (relativePath: string, contents: string): void => {
  writeTextFile(NodePath.join(paths.project, relativePath), contents);
};

const runGitInProject = (
  project: string,
  args: ReadonlyArray<string>,
  options: { readonly date?: string; readonly capture?: boolean } = {},
): string => {
  const result = ChildProcess.spawnSync("git", [...args], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.date
        ? {
            GIT_AUTHOR_DATE: options.date,
            GIT_COMMITTER_DATE: options.date,
          }
        : {}),
    },
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("git " + args.join(" ") + " failed with exit code " + String(result.status));
  }

  return typeof result.stdout === "string" ? result.stdout.trimEnd() : "";
};

const runGit = (
  args: ReadonlyArray<string>,
  options: { readonly date?: string; readonly capture?: boolean } = {},
): string => runGitInProject(paths.project, args, options);

const commit = (message: string, date: string): void => {
  runGit(["add", "."]);
  runGit(["commit", "-m", message], { date });
};

const readMetadata = (): StudioMetadata | undefined => {
  if (!FileSystem.existsSync(paths.metadata)) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(FileSystem.readFileSync(paths.metadata, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === STUDIO_KIND &&
      "version" in value &&
      value.version === STUDIO_VERSION &&
      "project" in value &&
      value.project === PROJECT_NAME
    ) {
      return value as StudioMetadata;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const hasOwnedAppDataRoot = (): boolean => {
  if (!FileSystem.existsSync(paths.appDataMetadata)) {
    return false;
  }

  try {
    const value: unknown = JSON.parse(FileSystem.readFileSync(paths.appDataMetadata, "utf8"));
    return (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === APP_DATA_KIND &&
      "version" in value &&
      value.version === STUDIO_VERSION
    );
  } catch {
    return false;
  }
};

const assertSafeStudioRoot = (): void => {
  const parsed = NodePath.parse(paths.root);
  if (
    paths.root === parsed.root ||
    paths.root === NodePath.resolve(NodeOS.homedir()) ||
    paths.root === REPO_ROOT
  ) {
    throw new Error("Refusing to use an unsafe marketing studio root: " + paths.root);
  }
};

const assertSafeAppDataRoot = (): void => {
  const parsed = NodePath.parse(paths.appData);
  if (
    paths.appData === parsed.root ||
    paths.appData === NodePath.resolve(NodeOS.homedir()) ||
    paths.appData === REPO_ROOT ||
    paths.appData === paths.root
  ) {
    throw new Error("Refusing to use an unsafe Marketing Studio app-data root: " + paths.appData);
  }
  if (!USER_DATA_DIR_NAME_PATTERN.test(NodePath.basename(paths.appData))) {
    throw new Error(
      "Marketing Studio app-data directory name must use letters, numbers, dots, dashes, or underscores: " +
        paths.appData,
    );
  }
};

const ensureAppDataRoot = (): void => {
  assertSafeAppDataRoot();

  if (FileSystem.existsSync(paths.appData)) {
    if (!FileSystem.statSync(paths.appData).isDirectory()) {
      throw new Error("Marketing Studio app-data path is not a directory: " + paths.appData);
    }
    if (FileSystem.readdirSync(paths.appData).length > 0 && !hasOwnedAppDataRoot()) {
      throw new Error(
        lines(
          "The Marketing Studio app-data directory contains files but is not owned by Threadlines:",
          paths.appData,
          "Choose an empty path with THREADLINES_MARKETING_STUDIO_APP_DATA_DIR.",
        ).trimEnd(),
      );
    }
  }

  FileSystem.mkdirSync(paths.appData, { recursive: true });
  writeTextFile(
    paths.appDataMetadata,
    JSON.stringify(
      {
        kind: APP_DATA_KIND,
        version: STUDIO_VERSION,
      },
      null,
      2,
    ) + "\n",
  );
};

const ensureStudioRoot = (): void => {
  assertSafeStudioRoot();

  if (FileSystem.existsSync(paths.root)) {
    if (!FileSystem.statSync(paths.root).isDirectory()) {
      throw new Error("Marketing studio path is not a directory: " + paths.root);
    }

    const entries = FileSystem.readdirSync(paths.root);
    if (entries.length > 0 && !readMetadata()) {
      throw new Error(
        lines(
          "The marketing studio directory already contains files but is not owned by Threadlines:",
          paths.root,
          "Choose an empty path with THREADLINES_MARKETING_STUDIO_DIR.",
        ).trimEnd(),
      );
    }
  }

  FileSystem.mkdirSync(paths.root, { recursive: true });
  writeTextFile(
    paths.metadata,
    JSON.stringify(
      {
        kind: STUDIO_KIND,
        version: STUDIO_VERSION,
        project: PROJECT_NAME,
      } satisfies StudioMetadata,
      null,
      2,
    ) + "\n",
  );
  for (const directory of [
    paths.threadlinesHome,
    paths.fixtureBin,
    paths.worktrees,
    paths.captureMasters,
    paths.captureExports,
    paths.capturePosters,
  ]) {
    FileSystem.mkdirSync(directory, { recursive: true });
  }
  ensureAppDataRoot();
  writeTextFile(
    paths.windowState,
    JSON.stringify(
      {
        width: 1600,
        height: 934,
        isMaximized: false,
      },
      null,
      2,
    ) + "\n",
  );
};

const writeStudioReadme = (): void => {
  writeTextFile(
    NodePath.join(paths.root, "README.md"),
    lines(
      "# Threadlines Marketing Studio",
      "",
      "This directory is an isolated, disposable capture environment. It does not use the",
      "normal Threadlines desktop profile, project list, or session database.",
      "",
      "## Layout",
      "",
      "- Orbit: primary synthetic product repository used in feature shots",
      "- Lumen: companion feature-delivery project with an amber favicon",
      "- Northstar: companion observability project with a cyan favicon",
      "- .worktrees: branch-specific workspaces behind the seeded thread history",
      "- Captures/Masters: untouched source recordings and full-resolution screenshots",
      "- Captures/Exports: generated desktop and mobile delivery assets",
      "- Captures/Posters: still frames and video poster images",
      "- Capture Plan.json: deterministic 0.3.0 scene, geometry, and safety requirements",
      "- .threadlines: isolated Threadlines server and session state",
      "- Electron browser state: " + paths.appData,
      "",
      "## Capture stories",
      "",
      "1. Show the full workspace: project sidebar, agent conversation, browser, and source control.",
      "2. Show three live signals beside two quiet threads in a five-item inbox.",
      "3. Move from Project file editing into the live Orbit browser preview.",
      "4. Edit publish-safe data and watch the browser update.",
      "5. Use the browser review tools to attach exact visual context.",
      "6. Capture genuine native controls only for explicit platform-proof stills.",
      "",
      "Run from the Threadlines source checkout:",
      "",
      "    vp run marketing:studio",
      "",
      "Prepare and verify a scene before recording:",
      "",
      "    vp run marketing:capture:prepare -- --scene workspace-four-panel-overview-dark",
      "    vp run marketing:capture:preflight -- --scene workspace-four-panel-overview-dark",
      "",
      "The full operating guide is docs/marketing-capture-studio.md in the Threadlines checkout.",
      "",
      "Rebuild the synthetic project and clear only this isolated profile:",
      "",
      "    vp run marketing:studio:reset -- --force",
    ),
  );
};

const writeFoundation = (): void => {
  writeProjectFile(".gitignore", lines("node_modules", "dist", ".DS_Store", "*.local"));
  writeProjectFile(
    "favicon.svg",
    lines(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
      '  <rect width="64" height="64" rx="16" fill="#18132b"/>',
      '  <ellipse cx="32" cy="32" rx="23" ry="10" fill="none" stroke="#a78bfa" stroke-width="5" transform="rotate(-24 32 32)"/>',
      '  <circle cx="32" cy="32" r="10" fill="#8b9cff"/>',
      '  <circle cx="51" cy="18" r="5" fill="#f5f3ff"/>',
      "</svg>",
    ),
  );
  writeProjectFile(
    "package.json",
    JSON.stringify(
      {
        name: "@orbit/dashboard",
        private: true,
        version: "0.9.0",
        type: "module",
        scripts: {
          dev: "node scripts/demo-server.mjs",
          test: "vitest run",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          react: "^19.1.0",
          "react-dom": "^19.1.0",
        },
        devDependencies: {
          typescript: "^5.8.0",
          vite: "^7.0.0",
          vitest: "^3.2.0",
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeProjectFile(
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
        },
        include: ["src", "tests"],
      },
      null,
      2,
    ) + "\n",
  );
  writeProjectFile(
    "README.md",
    lines(
      "# Orbit",
      "",
      "A calm systems dashboard for software teams.",
      "",
      "Orbit brings service health, background work, and operational signals into one focused",
      "workspace. This repository is a synthetic demo used for Threadlines product captures.",
      "",
      "## Product principles",
      "",
      "- Make risky states obvious before they become incidents.",
      "- Keep every recovery action reversible.",
      "- Prefer a useful default over another settings screen.",
    ),
  );
  writeProjectFile(
    "index.html",
    lines(
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '    <link rel="icon" href="/favicon.svg" />',
      '    <link rel="stylesheet" href="/src/styles.css" />',
      "    <title>Orbit · System overview</title>",
      "  </head>",
      "  <body>",
      '    <main id="app"></main>',
      '    <script type="module" src="/src/demo.js"></script>',
      "  </body>",
      "</html>",
    ),
  );
  writeProjectFile(
    "src/demoData.js",
    lines(
      "export const release = {",
      '  name: "System overview",',
      '  environment: "Live workspace",',
      '  status: "All systems operational",',
      "  progress: 100,",
      "};",
      "",
      "export const metrics = [",
      '  { label: "P95 latency", value: "184ms", change: "−12ms" },',
      '  { label: "Error rate", value: "0.08%", change: "−0.02%" },',
      '  { label: "Queue depth", value: "12", change: "normal" },',
      "];",
      "",
      "export const checks = [",
      '  { label: "API gateway", detail: "Stable · 38ms", state: "passed" },',
      '  { label: "Worker queue", detail: "12 jobs in flight", state: "passed" },',
      '  { label: "Data sync", detail: "Updated 3 minutes ago", state: "passed" },',
      "];",
    ),
  );
  writeProjectFile(
    "src/demo.js",
    lines(
      'import { checks, metrics, release } from "./demoData.js";',
      "",
      'const requestedTheme = new URLSearchParams(window.location.search).get("theme");',
      'document.documentElement.dataset.theme = requestedTheme === "light" ? "light" : "dark";',
      "",
      'const app = document.querySelector("#app");',
      "",
      "app.innerHTML = `",
      '  <header class="topbar">',
      '    <div class="brand"><span class="orbit-mark"></span>Orbit</div>',
      '    <nav aria-label="Workspace"><span>Overview</span><span>Services</span><span>Activity</span></nav>',
      '    <div class="agent-update" role="status" aria-live="polite" hidden><span></span><strong>Agent applying annotation…</strong></div>',
      '    <button class="avatar" aria-label="Maya Chen">MC</button>',
      "  </header>",
      '  <section class="intro">',
      "    <div>",
      '      <p class="eyebrow">${release.environment} · Updated now</p>',
      "      <h1>${release.name}</h1>",
      '      <p class="lede">Three services are healthy and background work is within expected limits.</p>',
      "    </div>",
      '    <button class="launch-button">View activity</button>',
      "  </section>",
      '  <section class="metrics" aria-label="Release metrics">',
      "    ${metrics",
      "      .map(",
      "        (metric) => `",
      "          <article><p>${metric.label}</p><strong>${metric.value}</strong><span>${metric.change}</span></article>",
      "        `,",
      "      )",
      '      .join("")}',
      "  </section>",
      '  <section class="readiness">',
      '    <div class="readiness-heading">',
      "      <div>",
      '        <p class="eyebrow">Service health</p>',
      "        <h2>${release.status}</h2>",
      "      </div>",
      "      <strong>${release.progress}%</strong>",
      "    </div>",
      '    <div class="progress"><span style="width: ${release.progress}%"></span></div>',
      '    <div class="checks">',
      "      ${checks",
      "        .map(",
      "          (check) => `",
      '            <div class="check"><span class="check-dot ${check.state}"></span><strong>${check.label}</strong><small>${check.detail}</small></div>',
      "          `,",
      "        )",
      '        .join("")}',
      "    </div>",
      "  </section>",
      "`;",
      "",
      'const activityButton = document.querySelector(".launch-button");',
      'const statusHeading = document.querySelector(".readiness h2");',
      'const statusEyebrow = document.querySelector(".readiness .eyebrow");',
      'const statusProgress = document.querySelector(".readiness-heading > strong");',
      'const progressBar = document.querySelector(".progress span");',
      'const introSummary = document.querySelector(".lede");',
      'const readiness = document.querySelector(".readiness");',
      'const agentUpdate = document.querySelector(".agent-update");',
      'const agentUpdateLabel = document.querySelector(".agent-update strong");',
      "let activityReviewed = false;",
      "let annotationTimer;",
      "let annotationStatusTimer;",
      "",
      "const renderActivityState = (reviewed) => {",
      "  activityReviewed = reviewed;",
      '  activityButton.textContent = reviewed ? "Activity checked" : "View activity";',
      '  activityButton.style.background = reviewed ? "var(--positive)" : "";',
      '  activityButton.style.color = reviewed ? "var(--accent-contrast)" : "";',
      '  statusHeading.textContent = reviewed ? "No issues detected" : release.status;',
      "  statusProgress.textContent = `${release.progress}%`;",
      "  progressBar.style.width = `${release.progress}%`;",
      "  introSummary.textContent = reviewed",
      '    ? "All services are healthy and recent activity has been reviewed."',
      '    : "Three services are healthy and background work is within expected limits.";',
      "};",
      "",
      'activityButton.addEventListener("click", () => renderActivityState(!activityReviewed));',
      "",
      "window.__threadlinesApplyAnnotationDemo = () => {",
      "  clearTimeout(annotationTimer);",
      "  clearTimeout(annotationStatusTimer);",
      '  readiness.dataset.agentState = "working";',
      "  agentUpdate.hidden = false;",
      '  agentUpdate.dataset.state = "working";',
      '  agentUpdateLabel.textContent = "Agent applying annotation…";',
      "  annotationTimer = setTimeout(() => {",
      '    readiness.dataset.agentState = "applied";',
      '    statusEyebrow.textContent = "Live service health";',
      '    statusHeading.textContent = "All services healthy";',
      '    statusProgress.textContent = "3 / 3 online";',
      '    introSummary.textContent = "Service health is clear at a glance, with the same operational detail close by.";',
      '    agentUpdate.dataset.state = "applied";',
      '    agentUpdateLabel.textContent = "Preview updated";',
      "    annotationStatusTimer = setTimeout(() => {",
      "      agentUpdate.hidden = true;",
      "    }, 1800);",
      "  }, 1200);",
      "};",
      "",
      "window.__threadlinesResetAnnotationDemo = () => {",
      "  clearTimeout(annotationTimer);",
      "  clearTimeout(annotationStatusTimer);",
      "  delete readiness.dataset.agentState;",
      '  statusEyebrow.textContent = "Service health";',
      "  statusHeading.textContent = release.status;",
      "  statusProgress.textContent = `${release.progress}%`;",
      "  progressBar.style.width = `${release.progress}%`;",
      '  introSummary.textContent = "Three services are healthy and background work is within expected limits.";',
      "  agentUpdate.hidden = true;",
      "  delete agentUpdate.dataset.state;",
      '  agentUpdateLabel.textContent = "Agent applying annotation…";',
      '  window.scrollTo({ top: 0, behavior: "instant" });',
      "};",
      "",
      'const events = new EventSource("/__threadlines_reload");',
      'events.addEventListener("change", () => window.location.reload());',
    ),
  );
  writeProjectFile(
    "src/styles.css",
    lines(
      ":root {",
      "  color-scheme: dark;",
      '  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      "  --background: #0b0d10;",
      "  --foreground: #f5f7fa;",
      "  --muted: #8d99a6;",
      "  --border: #29313a;",
      "  --surface: #171b20;",
      "  --surface-border: #39434d;",
      "  --accent: #8b9cff;",
      "  --accent-strong: #a78bfa;",
      "  --accent-contrast: #0d0f13;",
      "  --positive: #5ee6a8;",
      "  --warning: #fbbf24;",
      "  --progress-track: #242a31;",
      "  --ambient: rgb(139 156 255 / 12%);",
      "  background: var(--background);",
      "  color: var(--foreground);",
      "}",
      ':root[data-theme="light"] {',
      "  color-scheme: light;",
      "  --background: #f7f8fa;",
      "  --foreground: #17191d;",
      "  --muted: #626b76;",
      "  --border: #d8dde5;",
      "  --surface: #ffffff;",
      "  --surface-border: #c8ced8;",
      "  --accent: #586bda;",
      "  --accent-strong: #6552c7;",
      "  --accent-contrast: #ffffff;",
      "  --positive: #16805f;",
      "  --warning: #a16207;",
      "  --progress-track: #e4e7ec;",
      "  --ambient: rgb(88 107 218 / 9%);",
      "}",
      "* { box-sizing: border-box; }",
      "body { margin: 0; min-width: 0; min-height: 100vh; overflow-x: hidden; background: radial-gradient(circle at 88% -8%, var(--ambient), transparent 34%), var(--background); }",
      "button { font: inherit; }",
      "#app { width: min(1120px, calc(100% - 64px)); margin: 0 auto; }",
      ".topbar { height: 68px; display: flex; align-items: center; border-bottom: 1px solid var(--border); }",
      ".brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -0.02em; }",
      ".orbit-mark { width: 18px; height: 18px; border: 4px solid var(--accent-strong); border-radius: 50%; transform: rotate(-24deg) scaleY(.55); }",
      ".topbar nav { display: flex; gap: 28px; margin-left: 48px; color: var(--muted); font-size: 14px; }",
      ".topbar nav span:first-child { color: var(--foreground); }",
      ".agent-update { display: flex; align-items: center; gap: 7px; margin-left: auto; color: var(--muted); font-size: 12px; }",
      ".agent-update[hidden] { display: none; }",
      ".agent-update span { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent); }",
      ".agent-update strong { font-weight: 600; }",
      '.agent-update[data-state="working"] span { animation: agent-pulse 900ms ease-in-out infinite alternate; }',
      '.agent-update[data-state="applied"] { color: var(--positive); }',
      '.agent-update[data-state="applied"] span { background: var(--positive); box-shadow: 0 0 0 4px color-mix(in srgb, var(--positive) 14%, transparent); }',
      ".avatar { margin-left: auto; width: 32px; height: 32px; border: 1px solid var(--surface-border); border-radius: 50%; background: var(--surface); color: var(--foreground); font-size: 11px; }",
      ".agent-update + .avatar { margin-left: 16px; }",
      ".intro { display: flex; align-items: flex-end; justify-content: space-between; padding: 52px 0 38px; border-bottom: 1px solid var(--border); }",
      ".eyebrow { margin: 0 0 10px; color: var(--accent); font-size: 12px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }",
      "h1 { margin: 0; font-size: 40px; line-height: 1.05; letter-spacing: -0.035em; }",
      ".lede { max-width: 620px; margin: 14px 0 0; color: var(--muted); font-size: 16px; line-height: 1.55; }",
      ".launch-button { border: 0; border-radius: 8px; padding: 11px 16px; background: var(--accent); color: var(--accent-contrast); font-weight: 700; }",
      ".metrics { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--border); }",
      ".metrics article { padding: 28px 0; }",
      ".metrics article + article { padding-left: 28px; border-left: 1px solid var(--border); }",
      ".metrics p { margin: 0 0 10px; color: var(--muted); font-size: 13px; }",
      ".metrics strong { font-size: 26px; letter-spacing: -0.025em; }",
      ".metrics span { margin-left: 10px; color: var(--positive); font-size: 12px; }",
      ".readiness { padding: 34px 0; }",
      ".readiness-heading { display: flex; align-items: flex-end; justify-content: space-between; transition: background-color 180ms ease, border-color 180ms ease, padding 180ms ease; }",
      ".readiness h2 { margin: 0; font-size: 20px; }",
      ".readiness-heading > strong { color: var(--accent-strong); font-size: 24px; }",
      ".progress { height: 4px; margin: 20px 0 28px; overflow: hidden; background: var(--progress-track); }",
      ".progress span { display: block; height: 100%; background: var(--accent); }",
      '.readiness[data-agent-state="working"] .readiness-heading { outline: 2px solid color-mix(in srgb, var(--accent) 72%, transparent); outline-offset: 7px; }',
      '.readiness[data-agent-state="applied"] .readiness-heading { align-items: center; padding: 13px 15px; border: 1px solid color-mix(in srgb, var(--positive) 38%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--positive) 10%, var(--surface)); }',
      '.readiness[data-agent-state="applied"] .readiness-heading .eyebrow { margin-bottom: 5px; color: var(--positive); }',
      '.readiness[data-agent-state="applied"] .readiness-heading > strong { color: var(--positive); font-size: 13px; letter-spacing: .02em; }',
      '.readiness[data-agent-state="applied"] .progress { height: 0; margin: 16px 0 12px; opacity: 0; }',
      '.readiness[data-agent-state="applied"] .checks { margin-top: 14px; }',
      ".checks { border-top: 1px solid var(--border); }",
      ".check { display: grid; grid-template-columns: 12px 1fr auto; align-items: center; gap: 12px; padding: 17px 0; border-bottom: 1px solid var(--border); }",
      ".check strong { font-size: 14px; }",
      ".check small { color: var(--muted); }",
      ".check-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warning); }",
      ".check-dot.passed { background: var(--positive); }",
      "@keyframes agent-pulse { from { opacity: .45; transform: scale(.8); } to { opacity: 1; transform: scale(1); } }",
      "@media (max-width: 800px) { #app { width: calc(100% - 36px); } .topbar { height: 60px; } .topbar nav { gap: 16px; margin-left: 24px; } .intro { align-items: flex-start; flex-direction: column; gap: 20px; padding: 36px 0 28px; } h1 { font-size: 34px; } .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } .metrics article { min-width: 0; padding: 22px 14px; } .metrics article:first-child { padding-left: 0; } .metrics article + article { padding-left: 14px; } .metrics strong { font-size: 24px; } .metrics span { display: block; margin: 6px 0 0; } .check small { text-align: right; } }",
      "@media (max-width: 520px) { .topbar nav span:last-child { display: none; } .metrics { grid-template-columns: 1fr; } .metrics article { padding: 18px 0; } .metrics article + article { padding-left: 0; border-left: 0; border-top: 1px solid var(--border); } }",
    ),
  );
  writeProjectFile(
    "scripts/demo-server.mjs",
    lines(
      'import { createServer } from "node:http";',
      'import { readFile, stat, writeFile } from "node:fs/promises";',
      'import { watch } from "node:fs";',
      'import { dirname, extname, join, normalize } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "",
      'const root = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));',
      'const port = Number.parseInt(process.env.PORT ?? "4173", 10);',
      "const readyFile = process.env.THREADLINES_MARKETING_DEMO_READY_FILE;",
      "const clients = new Set();",
      "const contentTypes = new Map([",
      '  [".html", "text/html; charset=utf-8"],',
      '  [".js", "text/javascript; charset=utf-8"],',
      '  [".css", "text/css; charset=utf-8"],',
      '  [".svg", "image/svg+xml"],',
      "]);",
      "",
      "const server = createServer(async (request, response) => {",
      '  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");',
      '  if (requestUrl.pathname === "/__threadlines_reload") {',
      '    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });',
      '    response.write(": connected\\n\\n");',
      "    clients.add(response);",
      '    request.on("close", () => clients.delete(response));',
      "    return;",
      "  }",
      '  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);',
      "  const filePath = normalize(join(root, relativePath));",
      "  if (!filePath.startsWith(root)) { response.writeHead(403).end(); return; }",
      "  try {",
      "    const info = await stat(filePath);",
      '    if (!info.isFile()) throw new Error("not a file");',
      "    const body = await readFile(filePath);",
      '    response.writeHead(200, { "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream", "cache-control": "no-store" });',
      "    response.end(body);",
      "  } catch {",
      '    response.writeHead(404).end("Not found");',
      "  }",
      "});",
      "",
      "watch(root, { recursive: true }, (_event, fileName) => {",
      '  if (!fileName || fileName.startsWith(".git") || fileName.includes("node_modules")) return;',
      '  for (const client of clients) client.write("event: change\\ndata: reload\\n\\n");',
      "});",
      "",
      'server.listen(port, "127.0.0.1", async () => {',
      '  if (readyFile) await writeFile(readyFile, String(process.pid), "utf8");',
      "});",
    ),
  );
  writeProjectFile(
    "src/config/featureFlags.ts",
    lines(
      'export type FeatureFlag = "checkoutRecovery" | "usageInsights" | "releaseGuard";',
      "",
      "const defaults: Record<FeatureFlag, boolean> = {",
      "  checkoutRecovery: true,",
      "  usageInsights: true,",
      "  releaseGuard: false,",
      "};",
      "",
      "export function isFeatureEnabled(",
      "  flag: FeatureFlag,",
      "  overrides: Partial<Record<FeatureFlag, boolean>> = {},",
      "): boolean {",
      "  return overrides[flag] ?? defaults[flag];",
      "}",
      "",
      "export function enabledFeatures(): FeatureFlag[] {",
      "  return Object.entries(defaults)",
      "    .filter(([, enabled]) => enabled)",
      "    .map(([flag]) => flag as FeatureFlag);",
      "}",
    ),
  );
  writeProjectFile(
    "src/api/client.ts",
    lines(
      "export interface ApiClientOptions {",
      "  readonly baseUrl: string;",
      "  readonly timeoutMs?: number;",
      "}",
      "",
      "export function createApiClient(options: ApiClientOptions) {",
      "  const timeoutMs = options.timeoutMs ?? 4_000;",
      "",
      "  return async function request<T>(path: string): Promise<T> {",
      "    const response = await fetch(new URL(path, options.baseUrl), {",
      "      signal: AbortSignal.timeout(timeoutMs),",
      "    });",
      "",
      "    if (!response.ok) {",
      '      throw new Error("Request failed with status " + response.status);',
      "    }",
      "",
      "    return (await response.json()) as T;",
      "  };",
      "}",
    ),
  );
  writeProjectFile(
    "docs/product-principles.md",
    lines(
      "# Product principles",
      "",
      "Orbit is designed around three promises:",
      "",
      "1. Important state should be understandable at a glance.",
      "2. Every destructive action should have a nearby recovery path.",
      "3. Operational context belongs next to the work, not in another dashboard.",
    ),
  );
  writeProjectFile(
    "docs/release-checklist.md",
    lines(
      "# Release checklist",
      "",
      "- [ ] Checkout recovery tested",
      "- [ ] Usage limits verified",
      "- [ ] Release guard enabled",
      "- [ ] Poster frame exported",
    ),
  );
};

const writeDashboard = (): void => {
  writeProjectFile(
    "src/theme.ts",
    lines(
      "export const theme = {",
      "  color: {",
      '    canvas: "#0b0d10",',
      '    panel: "#14181d",',
      '    border: "#29313a",',
      '    text: "#f5f7fa",',
      '    muted: "#8d99a6",',
      '    accent: "#a78bfa",',
      '    success: "#5ee6a8",',
      "  },",
      "  radius: {",
      "    panel: 14,",
      "    control: 8,",
      "  },",
      "} as const;",
    ),
  );
  writeProjectFile(
    "src/components/CheckoutSummary.tsx",
    lines(
      "interface CheckoutSummaryProps {",
      "  readonly plan: string;",
      "  readonly seats: number;",
      "  readonly subtotal: number;",
      "}",
      "",
      "const formatCurrency = (value: number): string =>",
      '  new Intl.NumberFormat("en-US", {',
      '    style: "currency",',
      '    currency: "USD",',
      "  }).format(value);",
      "",
      "export function CheckoutSummary({ plan, seats, subtotal }: CheckoutSummaryProps) {",
      "  return (",
      '    <section aria-label="Checkout summary">',
      '      <p className="eyebrow">Ready to launch</p>',
      "      <h2>{plan}</h2>",
      "      <dl>",
      "        <div>",
      "          <dt>Seats</dt>",
      "          <dd>{seats}</dd>",
      "        </div>",
      "        <div>",
      "          <dt>Total today</dt>",
      "          <dd>{formatCurrency(subtotal)}</dd>",
      "        </div>",
      "      </dl>",
      "    </section>",
      "  );",
      "}",
    ),
  );
  writeProjectFile(
    "src/App.tsx",
    lines(
      'import { CheckoutSummary } from "./components/CheckoutSummary";',
      "",
      "export function App() {",
      "  return (",
      "    <main>",
      "      <header>",
      '        <span className="wordmark">Orbit</span>',
      "        <h1>Launch with confidence.</h1>",
      "      </header>",
      '      <CheckoutSummary plan="Scale" seats={12} subtotal={948} />',
      "    </main>",
      "  );",
      "}",
    ),
  );
};

const writeUsageInsights = (): void => {
  writeProjectFile(
    "src/lib/usage.ts",
    lines(
      "export interface UsageWindow {",
      "  readonly used: number;",
      "  readonly limit: number;",
      "  readonly resetsAt: Date;",
      "}",
      "",
      "export function usagePercentage(window: UsageWindow): number {",
      "  if (window.limit <= 0) return 0;",
      "  return Math.min(100, Math.round((window.used / window.limit) * 100));",
      "}",
    ),
  );
  writeProjectFile(
    "src/components/UsageMeter.tsx",
    lines(
      'import { usagePercentage, type UsageWindow } from "../lib/usage";',
      "",
      "interface UsageMeterProps {",
      "  readonly label: string;",
      "  readonly window: UsageWindow;",
      "}",
      "",
      "export function UsageMeter({ label, window }: UsageMeterProps) {",
      "  const percentage = usagePercentage(window);",
      "",
      "  return (",
      '    <section className="usage-meter">',
      "      <div>",
      "        <span>{label}</span>",
      "        <strong>{percentage}%</strong>",
      "      </div>",
      "      <progress max={100} value={percentage} />",
      "      <small>Resets {window.resetsAt.toLocaleDateString()}</small>",
      "    </section>",
      "  );",
      "}",
    ),
  );
};

const writeUsageTests = (): void => {
  writeProjectFile(
    "tests/usage.test.ts",
    lines(
      'import { describe, expect, it } from "vite-plus/test";',
      "",
      'import { usagePercentage } from "../src/lib/usage";',
      "",
      'describe("usagePercentage", () => {',
      '  it("caps usage at one hundred percent", () => {',
      "    expect(",
      "      usagePercentage({ used: 1_240, limit: 1_000, resetsAt: new Date(0) }),",
      "    ).toBe(100);",
      "  });",
      "});",
    ),
  );
};

const writeRetrySupport = (): void => {
  writeProjectFile(
    "src/lib/retry.ts",
    lines(
      "export interface RetryOptions {",
      "  readonly attempts: number;",
      "  readonly baseDelayMs: number;",
      "}",
      "",
      "const wait = (delayMs: number) =>",
      "  new Promise<void>((resolve) => setTimeout(resolve, delayMs));",
      "",
      "export async function withRetry<T>(",
      "  operation: () => Promise<T>,",
      "  options: RetryOptions,",
      "): Promise<T> {",
      "  let lastError: unknown;",
      "",
      "  for (let attempt = 0; attempt < options.attempts; attempt += 1) {",
      "    try {",
      "      return await operation();",
      "    } catch (error) {",
      "      lastError = error;",
      "      await wait(options.baseDelayMs * 2 ** attempt);",
      "    }",
      "  }",
      "",
      "  throw lastError;",
      "}",
    ),
  );
  writeProjectFile(
    "tests/retry.test.ts",
    lines(
      'import { describe, expect, it, vi } from "vite-plus/test";',
      "",
      'import { withRetry } from "../src/lib/retry";',
      "",
      'describe("withRetry", () => {',
      '  it("returns after a transient failure", async () => {',
      "    const operation = vi",
      "      .fn<() => Promise<string>>()",
      '      .mockRejectedValueOnce(new Error("temporary"))',
      '      .mockResolvedValue("ready");',
      "",
      "    await expect(withRetry(operation, { attempts: 2, baseDelayMs: 1 })).resolves.toBe(",
      '      "ready",',
      "    );",
      "  });",
      "});",
    ),
  );
};

const writeCheckoutTimeoutFix = (): void => {
  writeProjectFile(
    "src/api/checkout.ts",
    lines(
      'import { withRetry } from "../lib/retry";',
      "",
      "const CHECKOUT_TIMEOUT_MS = 8_000;",
      "",
      "export async function loadCheckout(checkoutId: string): Promise<Response> {",
      "  return withRetry(",
      '    () => fetch("/api/checkouts/" + checkoutId, {',
      "      signal: AbortSignal.timeout(CHECKOUT_TIMEOUT_MS),",
      "    }),",
      "    { attempts: 3, baseDelayMs: 250 },",
      "  );",
      "}",
    ),
  );
};

const writeProjectFilesBranch = (): void => {
  writeProjectFile(
    "docs/project-files.md",
    lines(
      "# Project files",
      "",
      "The command palette should make file context feel direct:",
      "",
      "- Search the full repository without leaving the conversation.",
      "- Keep related files open in stable tabs.",
      "- Select exact lines before attaching context.",
      "- Make a small edit, save it, and continue the same thought in chat.",
    ),
  );
  writeProjectFile(
    "src/files/selection.ts",
    lines(
      "export interface LineSelection {",
      "  readonly path: string;",
      "  readonly startLine: number;",
      "  readonly endLine: number;",
      "}",
      "",
      "export function selectionLabel(selection: LineSelection): string {",
      '  return selection.path + ":" + selection.startLine + "-" + selection.endLine;',
      "}",
    ),
  );
};

const writeGitSummary = (): void => {
  writeProjectFile(
    "src/git/changeSummary.ts",
    lines(
      'export type ChangeKind = "added" | "modified" | "deleted";',
      "",
      "export interface FileChange {",
      "  readonly path: string;",
      "  readonly kind: ChangeKind;",
      "  readonly additions: number;",
      "  readonly deletions: number;",
      "}",
      "",
      "export function summarizeChanges(changes: readonly FileChange[]): string {",
      "  const additions = changes.reduce((total, change) => total + change.additions, 0);",
      "  const deletions = changes.reduce((total, change) => total + change.deletions, 0);",
      '  return changes.length + " files · +" + additions + " −" + deletions;',
      "}",
    ),
  );
};

const stageCaptureState = (): void => {
  writeProjectFile(
    "src/theme.ts",
    lines(
      "export const theme = {",
      "  color: {",
      '    canvas: "#0b0d10",',
      '    panel: "#14181d",',
      '    border: "#2f3944",',
      '    text: "#f5f7fa",',
      '    muted: "#8d99a6",',
      '    accent: "#8b9cff",',
      '    success: "#5ee6a8",',
      "  },",
      "  radius: {",
      "    panel: 16,",
      "    control: 9,",
      "  },",
      "} as const;",
    ),
  );
  runGit(["add", "src/theme.ts"]);

  writeProjectFile(
    "src/components/CheckoutSummary.tsx",
    lines(
      "interface CheckoutSummaryProps {",
      "  readonly plan: string;",
      "  readonly seats: number;",
      "  readonly subtotal: number;",
      "  readonly discount?: number;",
      "}",
      "",
      "const formatCurrency = (value: number): string =>",
      '  new Intl.NumberFormat("en-US", {',
      '    style: "currency",',
      '    currency: "USD",',
      "  }).format(value);",
      "",
      "export function CheckoutSummary({",
      "  plan,",
      "  seats,",
      "  subtotal,",
      "  discount = 0,",
      "}: CheckoutSummaryProps) {",
      "  const total = Math.max(0, subtotal - discount);",
      "",
      "  return (",
      '    <section aria-label="Checkout summary">',
      '      <p className="eyebrow">Ready to launch</p>',
      "      <h2>{plan}</h2>",
      "      <dl>",
      "        <div>",
      "          <dt>Seats</dt>",
      "          <dd>{seats}</dd>",
      "        </div>",
      "        {discount > 0 && (",
      "          <div>",
      "            <dt>Launch credit</dt>",
      "            <dd>−{formatCurrency(discount)}</dd>",
      "          </div>",
      "        )}",
      "        <div>",
      "          <dt>Total today</dt>",
      "          <dd>{formatCurrency(total)}</dd>",
      "        </div>",
      "      </dl>",
      "    </section>",
      "  );",
      "}",
    ),
  );
  writeProjectFile(
    "src/lib/retry.ts",
    lines(
      "export interface RetryOptions {",
      "  readonly attempts: number;",
      "  readonly baseDelayMs: number;",
      "  readonly maxDelayMs?: number;",
      "}",
      "",
      "const wait = (delayMs: number) =>",
      "  new Promise<void>((resolve) => setTimeout(resolve, delayMs));",
      "",
      "export async function withRetry<T>(",
      "  operation: () => Promise<T>,",
      "  options: RetryOptions,",
      "): Promise<T> {",
      "  let lastError: unknown;",
      "",
      "  for (let attempt = 0; attempt < options.attempts; attempt += 1) {",
      "    try {",
      "      return await operation();",
      "    } catch (error) {",
      "      lastError = error;",
      "      const exponentialDelay = options.baseDelayMs * 2 ** attempt;",
      "      await wait(Math.min(exponentialDelay, options.maxDelayMs ?? 5_000));",
      "    }",
      "  }",
      "",
      "  throw lastError;",
      "}",
    ),
  );
  writeProjectFile(
    "docs/release-checklist.md",
    lines(
      "# Release checklist",
      "",
      "- [x] Checkout recovery tested",
      "- [x] Usage limits verified",
      "- [ ] Release guard enabled",
      "- [ ] Poster frame exported",
    ),
  );
};

interface CompanionProjectInput {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly packageName: string;
  readonly accent: string;
  readonly favicon: string;
  readonly commitDate: string;
  readonly remoteRepository: string;
  readonly remoteUrl: string;
}

const ensureLocalGitHubRemote = (input: {
  readonly project: string;
  readonly remoteRepository: string;
  readonly remoteUrl: string;
}): void => {
  if (!FileSystem.existsSync(input.remoteRepository)) {
    FileSystem.mkdirSync(NodePath.dirname(input.remoteRepository), { recursive: true });
    runGitInProject(input.project, [
      "init",
      "--bare",
      "--initial-branch=main",
      input.remoteRepository,
    ]);
  }

  const localRemoteUrl = pathToFileURL(input.remoteRepository).href;
  const remoteNames = runGitInProject(input.project, ["remote"], { capture: true }).split("\n");
  if (remoteNames.includes("origin")) {
    runGitInProject(input.project, ["remote", "set-url", "origin", localRemoteUrl]);
  } else {
    runGitInProject(input.project, ["remote", "add", "origin", localRemoteUrl]);
  }
  runGitInProject(input.project, ["push", "--set-upstream", "origin", "main"]);
  runGitInProject(input.project, ["remote", "set-url", "origin", input.remoteUrl]);
  runGitInProject(input.project, ["config", "threadlines.marketing-local-remote", localRemoteUrl]);

  const legacyRewrite = ChildProcess.spawnSync(
    "git",
    ["config", "--unset-all", "url." + localRemoteUrl + ".insteadOf"],
    { cwd: input.project, encoding: "utf8" },
  );
  if (legacyRewrite.error) {
    throw legacyRewrite.error;
  }
};

const createCompanionRepository = (input: CompanionProjectInput): void => {
  if (FileSystem.existsSync(input.path)) {
    if (!FileSystem.existsSync(NodePath.join(input.path, ".git"))) {
      throw new Error("Companion project exists but is not a Git repository: " + input.path);
    }
  } else {
    FileSystem.mkdirSync(input.path, { recursive: true });
    runGitInProject(input.path, ["init", "--initial-branch=main"]);
    runGitInProject(input.path, ["config", "user.name", "Maya Chen"]);
    runGitInProject(input.path, ["config", "user.email", "maya@orbit.example"]);
    runGitInProject(input.path, ["config", "commit.gpgsign", "false"]);

    writeTextFile(
      NodePath.join(input.path, "README.md"),
      lines(
        "# " + input.title,
        "",
        input.description,
        "",
        "This synthetic repository is part of the Threadlines Marketing Studio.",
      ),
    );
    writeTextFile(
      NodePath.join(input.path, "package.json"),
      JSON.stringify(
        {
          name: input.packageName,
          private: true,
          version: "0.4.0",
          type: "module",
          scripts: {
            test: "vitest run",
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeTextFile(NodePath.join(input.path, "favicon.svg"), input.favicon);
    writeTextFile(
      NodePath.join(input.path, "src/index.ts"),
      lines(
        "export const service = {",
        '  name: "' + input.title + '",',
        '  status: "healthy",',
        '  accent: "' + input.accent + '",',
        "} as const;",
      ),
    );

    runGitInProject(input.path, ["add", "."]);
    runGitInProject(input.path, ["commit", "-m", "chore: establish " + input.title], {
      date: input.commitDate,
    });
  }

  ensureLocalGitHubRemote({
    project: input.path,
    remoteRepository: input.remoteRepository,
    remoteUrl: input.remoteUrl,
  });
};

const createDemoRepository = (): void => {
  if (FileSystem.existsSync(paths.project)) {
    throw new Error("Refusing to replace an existing demo project: " + paths.project);
  }

  FileSystem.mkdirSync(paths.project, { recursive: true });
  runGit(["init", "--initial-branch=main"]);
  runGit(["config", "user.name", "Maya Chen"]);
  runGit(["config", "user.email", "maya@orbit.example"]);
  runGit(["config", "commit.gpgsign", "false"]);

  writeFoundation();
  commit("chore: establish the Orbit workspace", "2026-06-02T09:12:00-04:00");

  writeDashboard();
  commit("feat: introduce the launch dashboard", "2026-06-03T14:26:00-04:00");
  runGit(["tag", "v0.7.0"]);

  runGit(["checkout", "-b", "feature/usage-insights"]);
  writeUsageInsights();
  commit("feat: visualize account usage at a glance", "2026-06-04T10:18:00-04:00");
  writeUsageTests();
  commit("test: cover usage limit boundaries", "2026-06-04T16:42:00-04:00");

  runGit(["checkout", "main"]);
  writeRetrySupport();
  commit("feat: retry transient checkout requests", "2026-06-05T11:07:00-04:00");
  runGit(["tag", "v0.8.0"]);

  runGit(["checkout", "-b", "fix/checkout-timeout"]);
  writeCheckoutTimeoutFix();
  commit("fix: give checkout recovery more time", "2026-06-05T15:31:00-04:00");

  runGit(["checkout", "main"]);
  runGit(["merge", "--no-ff", "feature/usage-insights", "-m", "merge: usage insights"], {
    date: "2026-06-06T09:44:00-04:00",
  });

  runGit(["checkout", "-b", "feature/project-files"]);
  writeProjectFilesBranch();
  commit("feat: define project file selections", "2026-06-06T13:20:00-04:00");

  runGit(["checkout", "main"]);
  writeGitSummary();
  commit("feat: summarize source control changes", "2026-06-07T10:05:00-04:00");
  runGit(["tag", "v0.9.0-rc.1", "HEAD^"]);

  FileSystem.mkdirSync(NodePath.dirname(paths.remoteRepository), { recursive: true });
  runGit(["init", "--bare", "--initial-branch=main", paths.remoteRepository]);
  runGit(["remote", "add", "origin", pathToFileURL(paths.remoteRepository).href]);
  runGit(["push", "--set-upstream", "origin", "main"]);
  runGit([
    "push",
    "origin",
    "feature/usage-insights",
    "fix/checkout-timeout",
    "feature/project-files",
    "--tags",
  ]);
  runGit(["remote", "set-url", "origin", "https://github.com/threadlines-labs/orbit-demo.git"]);
  runGit([
    "config",
    "threadlines.marketing-local-remote",
    pathToFileURL(paths.remoteRepository).href,
  ]);

  stageCaptureState();
};

const ensureCompanionRepositories = (): void => {
  createCompanionRepository({
    path: paths.lumenProject,
    title: "Lumen",
    description: "A fast feature-delivery service for experiments and staged rollouts.",
    packageName: "@studio/lumen",
    accent: "#fbbf24",
    commitDate: "2026-05-28T13:20:00-04:00",
    remoteRepository: paths.lumenRemoteRepository,
    remoteUrl: "https://github.com/threadlines-labs/lumen-demo.git",
    favicon: lines(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
      '  <rect width="64" height="64" rx="16" fill="#2a1d0b"/>',
      '  <circle cx="32" cy="32" r="12" fill="#fbbf24"/>',
      '  <path d="M32 7v9M32 48v9M7 32h9M48 32h9M14 14l7 7M43 43l7 7M50 14l-7 7M21 43l-7 7" stroke="#fde68a" stroke-width="5" stroke-linecap="round"/>',
      "</svg>",
    ),
  });
  createCompanionRepository({
    path: paths.northstarProject,
    title: "Northstar",
    description: "Release observability that turns noisy deploy signals into clear decisions.",
    packageName: "@studio/northstar",
    accent: "#67e8f9",
    commitDate: "2026-05-30T09:45:00-04:00",
    remoteRepository: paths.northstarRemoteRepository,
    remoteUrl: "https://github.com/threadlines-labs/northstar-demo.git",
    favicon: lines(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
      '  <rect width="64" height="64" rx="16" fill="#0b2430"/>',
      '  <path d="M32 7l6.5 18.5L57 32l-18.5 6.5L32 57l-6.5-18.5L7 32l18.5-6.5z" fill="#67e8f9"/>',
      '  <circle cx="32" cy="32" r="5" fill="#ecfeff"/>',
      "</svg>",
    ),
  });
};

interface MarketingModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly value: string;
  }>;
}

const CLAUDE_FABLE_HIGH = {
  instanceId: "claudeAgent",
  model: "claude-fable-5",
  options: [{ id: "effort", value: "high" }],
} satisfies MarketingModelSelection;

const GPT_SOL_MAX = {
  instanceId: "codex",
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "max" }],
} satisfies MarketingModelSelection;

interface MarketingThreadSeed {
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createdAt: string;
  readonly modelSelection: MarketingModelSelection;
  readonly interactionMode?: "default" | "plan";
  readonly scenario?: {
    readonly status:
      | "idle"
      | "working"
      | "starting"
      | "completed"
      | "pending-approval"
      | "awaiting-input"
      | "plan-ready"
      | "background"
      | "failed";
    readonly prompt: string;
    readonly assistantText?: string;
  };
}

interface MarketingProjectThreadSeed {
  readonly workspaceRoot: string;
  readonly threads: ReadonlyArray<MarketingThreadSeed>;
}

const ensureThreadWorktree = (input: {
  readonly project: string;
  readonly branch: string;
  readonly startPoint: string;
  readonly worktreePath: string;
}): void => {
  if (FileSystem.existsSync(input.worktreePath)) {
    if (!FileSystem.existsSync(NodePath.join(input.worktreePath, ".git"))) {
      throw new Error(
        "Marketing thread worktree path is not a Git worktree: " + input.worktreePath,
      );
    }
    return;
  }

  runGitInProject(input.project, ["worktree", "prune"]);
  const branches = runGitInProject(input.project, ["branch", "--format=%(refname:short)"], {
    capture: true,
  }).split("\n");
  if (!branches.includes(input.branch)) {
    runGitInProject(input.project, ["branch", input.branch, input.startPoint]);
  }

  FileSystem.mkdirSync(NodePath.dirname(input.worktreePath), { recursive: true });
  runGitInProject(input.project, ["worktree", "add", input.worktreePath, input.branch]);
};

const threadWorktreePath = (project: string, name: string): string =>
  NodePath.join(paths.worktrees, project, name);

const ensureThreadWorktrees = (): void => {
  for (const worktree of [
    {
      project: paths.project,
      branch: "feature/project-files",
      startPoint: "feature/project-files",
      worktreePath: threadWorktreePath("Orbit", "project-files"),
    },
    {
      project: paths.project,
      branch: "feature/usage-insights",
      startPoint: "feature/usage-insights",
      worktreePath: threadWorktreePath("Orbit", "usage-insights"),
    },
    {
      project: paths.northstarProject,
      branch: "studio/alert-grouping",
      startPoint: "main",
      worktreePath: threadWorktreePath("Northstar", "alert-grouping"),
    },
    {
      project: paths.lumenProject,
      branch: "studio/evaluation-cache",
      startPoint: "main",
      worktreePath: threadWorktreePath("Lumen", "evaluation-cache"),
    },
  ]) {
    ensureThreadWorktree(worktree);
  }
};

const installFixtureCommands = (): void => {
  for (const fixture of [
    { source: "gh.mjs", destination: "gh" },
    { source: "git.sh", destination: "git" },
    { source: "studio-shell.sh", destination: "threadlines-studio-shell" },
  ]) {
    const source = NodePath.join(REPO_ROOT, "scripts/fixtures/marketing-studio", fixture.source);
    const destination = NodePath.join(paths.fixtureBin, fixture.destination);
    FileSystem.copyFileSync(source, destination);
    FileSystem.chmodSync(destination, 0o755);
  }
};

const createdAtMinutesAgo = (now: number, minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const buildProjectThreadSeeds = (): ReadonlyArray<MarketingProjectThreadSeed> => {
  const now = Date.now();
  return [
    {
      workspaceRoot: paths.project,
      threads: [
        {
          title: "Checkout recovery",
          branch: "main",
          worktreePath: paths.project,
          createdAt: createdAtMinutesAgo(now, 8),
          modelSelection: GPT_SOL_MAX,
          scenario: {
            status: "awaiting-input",
            prompt:
              "Compare checkout recovery health across regions and ask which region should be the baseline.",
            assistantText:
              "The recovery paths are healthy. Which region should I use as the comparison baseline?",
          },
        },
        {
          title: "Project file editing",
          branch: "feature/project-files",
          worktreePath: threadWorktreePath("Orbit", "project-files"),
          createdAt: createdAtMinutesAgo(now, 2),
          modelSelection: CLAUDE_FABLE_HIGH,
          scenario: {
            status: "working",
            prompt: "Make project file selection labels clearer and verify the editor flow.",
            assistantText:
              "I updated the selection labels and am checking the file-to-chat flow across the editor.",
          },
        },
        {
          title: "Usage insights",
          branch: "feature/usage-insights",
          worktreePath: threadWorktreePath("Orbit", "usage-insights"),
          createdAt: createdAtMinutesAgo(now, 160),
          modelSelection: GPT_SOL_MAX,
          scenario: {
            status: "idle",
            prompt: "Add an at-a-glance usage summary for the launch dashboard.",
            assistantText:
              "Usage now reads clearly at a glance, with limits capped correctly and boundary coverage added.",
          },
        },
        {
          title: "Release guard",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 3_360),
          modelSelection: CLAUDE_FABLE_HIGH,
        },
        {
          title: "Design token cleanup",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 4_260),
          modelSelection: GPT_SOL_MAX,
        },
        {
          title: "Release checklist",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 5_760),
          modelSelection: CLAUDE_FABLE_HIGH,
        },
      ],
    },
    {
      workspaceRoot: paths.northstarProject,
      threads: [
        {
          title: "Deploy health",
          branch: "main",
          worktreePath: paths.northstarProject,
          createdAt: createdAtMinutesAgo(now, 52),
          modelSelection: CLAUDE_FABLE_HIGH,
          scenario: {
            status: "background",
            prompt: "Compare deploy health across the last three production releases and regions.",
            assistantText:
              "The initial comparison is complete. A longer regional health check is still running in the background.",
          },
        },
        {
          title: "Group noisy alerts",
          branch: "studio/alert-grouping",
          worktreePath: threadWorktreePath("Northstar", "alert-grouping"),
          createdAt: createdAtMinutesAgo(now, 3_180),
          modelSelection: GPT_SOL_MAX,
        },
        {
          title: "Trace sampling",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 3_720),
          modelSelection: CLAUDE_FABLE_HIGH,
        },
        {
          title: "Error budget dashboard",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 4_920),
          modelSelection: GPT_SOL_MAX,
        },
        {
          title: "Canary analysis",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 8_640),
          modelSelection: CLAUDE_FABLE_HIGH,
        },
      ],
    },
    {
      workspaceRoot: paths.lumenProject,
      threads: [
        {
          title: "Rollout cohorts",
          branch: "main",
          worktreePath: paths.lumenProject,
          createdAt: createdAtMinutesAgo(now, 210),
          modelSelection: GPT_SOL_MAX,
          interactionMode: "plan",
          scenario: {
            status: "idle",
            prompt: "Plan a safer way to define overlapping rollout cohorts.",
            assistantText:
              "I mapped the overlap cases and documented an explicit precedence rule for the next pass.",
          },
        },
        {
          title: "Evaluation cache",
          branch: "studio/evaluation-cache",
          worktreePath: threadWorktreePath("Lumen", "evaluation-cache"),
          createdAt: createdAtMinutesAgo(now, 4_080),
          modelSelection: CLAUDE_FABLE_HIGH,
        },
        {
          title: "Flag targeting",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 5_400),
          modelSelection: GPT_SOL_MAX,
        },
        {
          title: "SDK migration",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 7_200),
          modelSelection: CLAUDE_FABLE_HIGH,
        },
        {
          title: "Experiment guardrails",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 10_080),
          modelSelection: GPT_SOL_MAX,
        },
      ],
    },
  ];
};

const seedStudioThreads = (): void => {
  if (
    FileSystem.existsSync(paths.threadSeedMarker) &&
    FileSystem.readFileSync(paths.threadSeedMarker, "utf8").trim() === String(THREAD_SEED_VERSION)
  ) {
    return;
  }

  const projects = buildProjectThreadSeeds();
  writeTextFile(
    paths.threadSeedInput,
    JSON.stringify(
      {
        baseDir: paths.threadlinesHome,
        cwd: paths.project,
        devUrl: "http://127.0.0.1:6066",
        projects,
      },
      null,
      2,
    ) + "\n",
  );

  const result = ChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(REPO_ROOT, "apps/server/src/cli/marketingStudioSeed.ts"), paths.threadSeedInput],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        THREADLINES_LOG_LEVEL: "Error",
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = String(result.stdout ?? "") + String(result.stderr ?? "");
    throw new Error(
      "Failed to seed Marketing Studio threads." +
        (output.trim().length > 0 ? "\n" + output.trim() : ""),
    );
  }

  writeTextFile(paths.threadSeedMarker, String(THREAD_SEED_VERSION) + "\n");
  console.log("Seeded 6 Orbit, 5 Northstar, and 5 Lumen threads.");
};

const seedStudioProjects = (): void => {
  if (FileSystem.existsSync(paths.projectSeedMarker)) {
    return;
  }

  for (const project of [
    { path: paths.project, title: PROJECT_NAME },
    { path: paths.lumenProject, title: "Lumen" },
    { path: paths.northstarProject, title: "Northstar" },
  ]) {
    const result = ChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(REPO_ROOT, "apps/server/src/bin.ts"),
        "project",
        "add",
        "--base-dir",
        paths.threadlinesHome,
        project.path,
        "--title",
        project.title,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          THREADLINES_HOME: paths.threadlinesHome,
          THREADLINES_LOG_LEVEL: "Error",
          VITE_DEV_SERVER_URL: "http://127.0.0.1:6066",
        },
      },
    );
    if (result.error) {
      throw result.error;
    }

    const output = String(result.stdout ?? "") + String(result.stderr ?? "");
    if (result.status !== 0 && !output.includes("An active project already exists")) {
      throw new Error(
        "Failed to seed the " +
          project.title +
          " project into Marketing Studio." +
          (output.trim().length > 0 ? "\n" + output.trim() : ""),
      );
    }
  }

  writeTextFile(paths.projectSeedMarker, "Orbit\nLumen\nNorthstar\n");
};

const setupStudio = (): void => {
  ensureStudioRoot();
  writeStudioReadme();

  if (FileSystem.existsSync(paths.project)) {
    if (!FileSystem.existsSync(NodePath.join(paths.project, ".git"))) {
      throw new Error("Demo project exists but is not a Git repository: " + paths.project);
    }
    console.log("Marketing Studio is already set up.");
    ensureLocalGitHubRemote({
      project: paths.project,
      remoteRepository: paths.remoteRepository,
      remoteUrl: "https://github.com/threadlines-labs/orbit-demo.git",
    });
  } else {
    console.log("Creating the Orbit capture repository...");
    createDemoRepository();
    console.log("Marketing Studio is ready.");
  }
  ensureCompanionRepositories();
  ensureThreadWorktrees();
  installFixtureCommands();
  FileSystem.copyFileSync(
    NodePath.join(REPO_ROOT, "scripts/fixtures/marketing-studio/capture-scenes.json"),
    paths.capturePlan,
  );
  seedStudioProjects();
  seedStudioThreads();

  console.log("");
  printPaths();
};

const printPaths = (): void => {
  console.log("Studio root:      " + paths.root);
  console.log("Demo project:     " + paths.project);
  console.log("Threadlines data: " + paths.threadlinesHome);
  console.log("Desktop profile:  " + paths.appData);
  console.log("Capture masters:  " + paths.captureMasters);
  console.log("Capture exports:  " + paths.captureExports);
  console.log("Poster frames:    " + paths.capturePosters);
  console.log("Capture plan:     " + paths.capturePlan);
};

const waitForPath = (filePath: string, child: ChildProcess.ChildProcess): void => {
  const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (FileSystem.existsSync(filePath)) {
      return;
    }
    if (child.exitCode !== null) {
      throw new Error(
        "Orbit demo server exited before it was ready (code " + String(child.exitCode) + ").",
      );
    }
    Atomics.wait(sleeper, 0, 0, 50);
  }
  throw new Error("Orbit demo server did not become ready within 3 seconds.");
};

const launchStudio = (marketingCaptureMode = true): void => {
  setupStudio();
  console.log("");
  console.log("Launching isolated Threadlines Marketing Studio...");

  const demoReadyFile = NodePath.join(paths.root, ".orbit-demo-server-ready");
  FileSystem.rmSync(demoReadyFile, { force: true });
  const demoServer = ChildProcess.spawn(
    process.execPath,
    [NodePath.join(paths.project, "scripts/demo-server.mjs")],
    {
      cwd: paths.project,
      env: {
        ...process.env,
        PORT: "4173",
        THREADLINES_MARKETING_DEMO_READY_FILE: demoReadyFile,
      },
      stdio: "ignore",
    },
  );
  demoServer.on("error", () => undefined);

  let result: ChildProcess.SpawnSyncReturns<Buffer>;
  try {
    waitForPath(demoReadyFile, demoServer);
    console.log("Orbit demo:       http://127.0.0.1:4173");
    result = ChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(REPO_ROOT, "scripts/dev-runner.ts"),
        "dev:desktop",
        "--auto-bootstrap-project-from-cwd",
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          THREADLINES_DEV_INSTANCE: "marketing-studio",
          THREADLINES_HOME: paths.threadlinesHome,
          THREADLINES_DESKTOP_APP_DATA_DIR: NodePath.dirname(paths.appData),
          THREADLINES_DESKTOP_USER_DATA_DIR_NAME: NodePath.basename(paths.appData),
          THREADLINES_DESKTOP_BACKEND_CWD: paths.project,
          THREADLINES_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
          THREADLINES_DESKTOP_OPEN_DEVTOOLS: "0",
          THREADLINES_DESKTOP_MARKETING_CAPTURE: marketingCaptureMode ? "1" : "0",
          THREADLINES_CAPTURE_DEBUG_PORT:
            process.env.THREADLINES_CAPTURE_DEBUG_PORT ?? MARKETING_CAPTURE_DEBUG_PORT,
          THREADLINES_DESKTOP_RESTART_ON_REBUILD:
            process.env.THREADLINES_DESKTOP_RESTART_ON_REBUILD ?? "0",
          THREADLINES_DISABLE_AUTO_UPDATE: "1",
          PATH: paths.fixtureBin + NodePath.delimiter + (process.env.PATH ?? ""),
          // Keep this path whitespace-free: terminal shell resolution treats the
          // configured value as a command and the studio root intentionally has
          // spaces in its name. The fixture bin is already prepended to PATH.
          SHELL: "threadlines-studio-shell",
        },
        stdio: "inherit",
      },
    );
  } finally {
    demoServer.kill();
    FileSystem.rmSync(demoReadyFile, { force: true });
  }

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      result.signal
        ? "Marketing Studio stopped with signal " + result.signal
        : "Marketing Studio exited with code " + String(result.status),
    );
  }
};

const resetStudio = (force: boolean): void => {
  assertSafeStudioRoot();
  if (!force) {
    throw new Error(
      lines(
        "Reset clears only the isolated Marketing Studio profile and synthetic Orbit repo.",
        "Run again with --force:",
        "  vp run marketing:studio:reset -- --force",
      ).trimEnd(),
    );
  }
  if (!readMetadata()) {
    throw new Error("Refusing to reset a directory not owned by Marketing Studio: " + paths.root);
  }
  if (
    FileSystem.existsSync(paths.appData) &&
    FileSystem.readdirSync(paths.appData).length > 0 &&
    !hasOwnedAppDataRoot()
  ) {
    throw new Error(
      "Refusing to reset an app-data directory not owned by Marketing Studio: " + paths.appData,
    );
  }

  FileSystem.rmSync(paths.appData, { recursive: true, force: true });
  FileSystem.rmSync(paths.root, { recursive: true, force: true });
  setupStudio();
};

const printHelp = (): void => {
  console.log(
    lines(
      "Threadlines Marketing Studio",
      "",
      "Usage:",
      "  node scripts/marketing-studio.ts launch",
      "  node scripts/marketing-studio.ts launch-native",
      "  node scripts/marketing-studio.ts setup",
      "  node scripts/marketing-studio.ts paths",
      "  node scripts/marketing-studio.ts reset --force",
      "",
      "Set THREADLINES_MARKETING_STUDIO_DIR to choose a different studio root.",
    ).trimEnd(),
  );
};

const main = (): void => {
  const command = process.argv[2] ?? "launch";

  switch (command) {
    case "launch":
      launchStudio();
      break;
    case "launch-native":
      launchStudio(false);
      break;
    case "setup":
      setupStudio();
      break;
    case "paths":
      printPaths();
      break;
    case "reset":
      resetStudio(process.argv.slice(3).includes("--force"));
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error("Unknown Marketing Studio command: " + command);
  }
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
