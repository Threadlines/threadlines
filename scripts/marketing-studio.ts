#!/usr/bin/env node

import * as ChildProcess from "node:child_process";
import * as FileSystem from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STUDIO_KIND = "threadlines-marketing-studio";
const APP_DATA_KIND = "threadlines-marketing-studio-app-data";
const STUDIO_VERSION = 1;
const THREAD_SEED_VERSION = 2;
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
  const root = NodePath.resolve(
    configuredRoot && configuredRoot.length > 0
      ? configuredRoot
      : NodePath.join(NodeOS.homedir(), "Threadlines Marketing Studio"),
  );
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
        width: 1624,
        height: 995,
        isMaximized: true,
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
      "- Captures/Exports: cropped and compressed site-ready assets",
      "- Captures/Posters: still frames and video poster images",
      "- .threadlines: isolated Threadlines server and session state",
      "- Electron browser state: " + paths.appData,
      "",
      "## Capture stories",
      "",
      "1. Browse project files, open tabs, edit a feature flag, and save.",
      "2. Select a few useful lines and attach the selection to chat.",
      "3. Inspect staged and unstaged changes by file, then undo one file.",
      "4. Read the visual Git graph and inspect the open feature branches.",
      "5. Show the inhabited sidebar with 4 Orbit, 3 Northstar, and 2 Lumen threads.",
      "",
      "Run from the Threadlines source checkout:",
      "",
      "    vp run marketing:studio",
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
          dev: "vite",
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
      "A calm operations dashboard for teams shipping subscription products.",
      "",
      "Orbit brings checkout health, usage limits, and release readiness into one focused",
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
      'import { describe, expect, it } from "vitest";',
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
      'import { describe, expect, it, vi } from "vitest";',
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
        },
        {
          title: "Project file editing",
          branch: "feature/project-files",
          worktreePath: threadWorktreePath("Orbit", "project-files"),
          createdAt: createdAtMinutesAgo(now, 36),
          modelSelection: CLAUDE_FABLE_HIGH,
        },
        {
          title: "Usage insights",
          branch: "feature/usage-insights",
          worktreePath: threadWorktreePath("Orbit", "usage-insights"),
          createdAt: createdAtMinutesAgo(now, 160),
          modelSelection: GPT_SOL_MAX,
        },
        {
          title: "Release guard",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 1_380),
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
        },
        {
          title: "Group noisy alerts",
          branch: "studio/alert-grouping",
          worktreePath: threadWorktreePath("Northstar", "alert-grouping"),
          createdAt: createdAtMinutesAgo(now, 310),
          modelSelection: GPT_SOL_MAX,
        },
        {
          title: "Trace sampling",
          branch: null,
          worktreePath: null,
          createdAt: createdAtMinutesAgo(now, 2_880),
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
        },
        {
          title: "Evaluation cache",
          branch: "studio/evaluation-cache",
          worktreePath: threadWorktreePath("Lumen", "evaluation-cache"),
          createdAt: createdAtMinutesAgo(now, 4_320),
          modelSelection: CLAUDE_FABLE_HIGH,
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
  console.log("Seeded 4 Orbit, 3 Northstar, and 2 Lumen threads.");
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
};

const launchStudio = (): void => {
  setupStudio();
  console.log("");
  console.log("Launching isolated Threadlines Marketing Studio...");

  const result = ChildProcess.spawnSync(
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
        THREADLINES_DISABLE_AUTO_UPDATE: "1",
        PATH: paths.fixtureBin + NodePath.delimiter + (process.env.PATH ?? ""),
        SHELL: NodePath.join(paths.fixtureBin, "threadlines-studio-shell"),
      },
      stdio: "inherit",
    },
  );

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
