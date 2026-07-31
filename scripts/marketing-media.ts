#!/usr/bin/env node
// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FileSystem from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { resolveMarketingStudioRoot } from "./lib/marketing-studio-paths.ts";

type SceneKind = "motion" | "still";
type SceneAudience = "evergreen" | "release";
type SceneWindowMode = "neutral" | "native";
type SceneTheme = "light" | "dark";
type SceneCursorMode = "hidden" | "native";

interface CaptureScene {
  readonly id: string;
  readonly kind: SceneKind;
  readonly audience: SceneAudience;
  readonly windowMode: SceneWindowMode;
  readonly theme: SceneTheme;
  readonly cursorMode: SceneCursorMode;
  readonly project: string;
  readonly threadTitle: string;
  readonly browserUrl?: string | undefined;
  readonly sourceControlOpen: boolean;
  readonly durationSeconds?: number | undefined;
  readonly expectedLabels: ReadonlyArray<string>;
  readonly story: string;
}

interface CaptureManifest {
  readonly schemaVersion: 1;
  readonly release: string;
  readonly geometry: {
    readonly logicalWidth: number;
    readonly logicalHeight: number;
    readonly deviceScaleFactor: number;
    readonly masterWidth: number;
    readonly masterHeight: number;
    readonly framesPerSecond: number;
    readonly colorSpace: "bt709";
  };
  readonly capture: {
    readonly debugPort: number;
    readonly demoUrl: string;
    readonly preRollSeconds: number;
    readonly postRollSeconds: number;
  };
  readonly delivery: {
    readonly desktopWidth: number;
    readonly mobileWidth: number;
    readonly keyframeIntervalSeconds: number;
    readonly posterQuality: number;
  };
  readonly scenes: ReadonlyArray<CaptureScene>;
}

interface DevToolsTarget {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string | undefined;
}

interface RuntimeSnapshot {
  readonly captureMode: boolean;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly theme: "light" | "dark";
  readonly readyState: string;
  readonly activeProjectName: string | null;
  readonly activeThreadTitle: string | null;
  readonly text: string;
  readonly browserUrl: string | null;
  readonly sourceControlOpen: boolean;
}

interface CaptureRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface CaptureWindowInfo {
  readonly windowId: number;
  readonly bounds: CaptureRectangle;
  readonly displays: ReadonlyArray<CaptureRectangle>;
}

interface ProbeStream {
  readonly codec_name?: string | undefined;
  readonly codec_type?: string | undefined;
  readonly profile?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly pix_fmt?: string | undefined;
  readonly avg_frame_rate?: string | undefined;
  readonly r_frame_rate?: string | undefined;
  readonly color_space?: string | undefined;
  readonly color_transfer?: string | undefined;
  readonly color_primaries?: string | undefined;
}

interface ProbeResult {
  readonly streams: ReadonlyArray<ProbeStream>;
  readonly format?: {
    readonly duration?: string | undefined;
    readonly format_name?: string | undefined;
  };
}

const REPO_ROOT = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST_PATH = NodePath.join(
  REPO_ROOT,
  "scripts",
  "fixtures",
  "marketing-studio",
  "capture-scenes.json",
);
const STUDIO_METADATA_FILE = ".threadlines-marketing-studio.json";
const EXPECTED_PROJECTS = ["Orbit", "Lumen", "Northstar"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPositiveNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${context}.${key} must be a positive number.`);
  }
  return value;
}

export function parseCaptureManifest(value: unknown): CaptureManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.release !== "string" ||
    !isRecord(value.geometry) ||
    !isRecord(value.capture) ||
    !isRecord(value.delivery) ||
    !Array.isArray(value.scenes)
  ) {
    throw new Error("Marketing capture manifest has an invalid top-level shape.");
  }

  const geometryValues = {
    logicalWidth: readPositiveNumber(value.geometry, "logicalWidth", "geometry"),
    logicalHeight: readPositiveNumber(value.geometry, "logicalHeight", "geometry"),
    deviceScaleFactor: readPositiveNumber(value.geometry, "deviceScaleFactor", "geometry"),
    masterWidth: readPositiveNumber(value.geometry, "masterWidth", "geometry"),
    masterHeight: readPositiveNumber(value.geometry, "masterHeight", "geometry"),
    framesPerSecond: readPositiveNumber(value.geometry, "framesPerSecond", "geometry"),
    colorSpace: value.geometry.colorSpace,
  };
  if (geometryValues.colorSpace !== "bt709") {
    throw new Error("geometry.colorSpace must be bt709.");
  }
  if (
    geometryValues.masterWidth !== geometryValues.logicalWidth * geometryValues.deviceScaleFactor ||
    geometryValues.masterHeight !== geometryValues.logicalHeight * geometryValues.deviceScaleFactor
  ) {
    throw new Error("Master geometry must equal logical geometry multiplied by device scale.");
  }
  const geometry: CaptureManifest["geometry"] = {
    ...geometryValues,
    colorSpace: "bt709",
  };

  const captureValues = {
    debugPort: readPositiveNumber(value.capture, "debugPort", "capture"),
    demoUrl: value.capture.demoUrl,
    preRollSeconds: readPositiveNumber(value.capture, "preRollSeconds", "capture"),
    postRollSeconds: readPositiveNumber(value.capture, "postRollSeconds", "capture"),
  };
  if (typeof captureValues.demoUrl !== "string") {
    throw new Error("capture.demoUrl must be a URL string.");
  }
  if (!URL.canParse(captureValues.demoUrl)) {
    throw new Error("capture.demoUrl must be a valid URL.");
  }
  const capture: CaptureManifest["capture"] = {
    ...captureValues,
    demoUrl: captureValues.demoUrl,
  };

  const delivery = {
    desktopWidth: readPositiveNumber(value.delivery, "desktopWidth", "delivery"),
    mobileWidth: readPositiveNumber(value.delivery, "mobileWidth", "delivery"),
    keyframeIntervalSeconds: readPositiveNumber(
      value.delivery,
      "keyframeIntervalSeconds",
      "delivery",
    ),
    posterQuality: readPositiveNumber(value.delivery, "posterQuality", "delivery"),
  };

  const sceneIds = new Set<string>();
  const scenes = value.scenes.map((rawScene, index): CaptureScene => {
    if (
      !isRecord(rawScene) ||
      typeof rawScene.id !== "string" ||
      (rawScene.kind !== "motion" && rawScene.kind !== "still") ||
      (rawScene.audience !== "evergreen" && rawScene.audience !== "release") ||
      (rawScene.windowMode !== "neutral" && rawScene.windowMode !== "native") ||
      (rawScene.theme !== "light" && rawScene.theme !== "dark") ||
      (rawScene.cursorMode !== "hidden" && rawScene.cursorMode !== "native") ||
      typeof rawScene.project !== "string" ||
      typeof rawScene.threadTitle !== "string" ||
      (rawScene.browserUrl !== undefined && typeof rawScene.browserUrl !== "string") ||
      typeof rawScene.sourceControlOpen !== "boolean" ||
      (rawScene.durationSeconds !== undefined &&
        (typeof rawScene.durationSeconds !== "number" || rawScene.durationSeconds <= 0)) ||
      !Array.isArray(rawScene.expectedLabels) ||
      !rawScene.expectedLabels.every((label) => typeof label === "string") ||
      typeof rawScene.story !== "string"
    ) {
      throw new Error(`Marketing capture scene ${index + 1} is invalid.`);
    }
    if (sceneIds.has(rawScene.id)) {
      throw new Error(`Marketing capture scene id is duplicated: ${rawScene.id}`);
    }
    if (rawScene.kind === "motion" && rawScene.durationSeconds === undefined) {
      throw new Error(`Motion scene '${rawScene.id}' needs durationSeconds.`);
    }
    if (rawScene.browserUrl !== undefined) {
      if (!URL.canParse(rawScene.browserUrl)) {
        throw new Error(`Scene '${rawScene.id}' has an invalid browserUrl.`);
      }
    }
    sceneIds.add(rawScene.id);
    return rawScene as unknown as CaptureScene;
  });

  return {
    schemaVersion: 1,
    release: value.release,
    geometry,
    capture,
    delivery,
    scenes,
  };
}

function readManifest(): CaptureManifest {
  const manifestPath =
    process.env.THREADLINES_MARKETING_CAPTURE_MANIFEST?.trim() || DEFAULT_MANIFEST_PATH;
  return parseCaptureManifest(JSON.parse(FileSystem.readFileSync(manifestPath, "utf8")));
}

function studioPaths() {
  const root = resolveMarketingStudioRoot({
    configuredRoot: process.env.THREADLINES_MARKETING_STUDIO_DIR,
    homeDirectory: NodeOS.homedir(),
    publicDirectory: process.env.PUBLIC?.trim(),
  });
  const captures = NodePath.join(root, "Captures");
  return {
    root,
    masters: NodePath.join(captures, "Masters"),
    rawMasters: NodePath.join(captures, "Masters", "Raw"),
    exports: NodePath.join(captures, "Exports"),
    posters: NodePath.join(captures, "Posters"),
    qa: NodePath.join(captures, "QA"),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function requiredArgument(name: string): string {
  const value = argument(name)?.trim();
  if (!value) {
    throw new Error(`Missing required --${name} argument.`);
  }
  return value;
}

function resolveScene(manifest: CaptureManifest): CaptureScene {
  const sceneId = requiredArgument("scene");
  const scene = manifest.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) {
    throw new Error(
      `Unknown capture scene '${sceneId}'. Expected one of: ${manifest.scenes
        .map((candidate) => candidate.id)
        .join(", ")}`,
    );
  }
  return scene;
}

function commandExists(command: string): boolean {
  const result = ChildProcess.spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.error === undefined || (result.error as NodeJS.ErrnoException).code !== "ENOENT";
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string | undefined;
    readonly allowFailure?: boolean | undefined;
  } = {},
): string {
  const result = ChildProcess.spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || "")
      .trim()
      .slice(-4_000);
    throw new Error(
      `${command} failed with code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return String(result.stdout ?? "");
}

function probe(filePath: string): ProbeResult {
  return JSON.parse(
    run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath]),
  ) as ProbeResult;
}

function frameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? 1);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : 0;
}

function videoStream(result: ProbeResult): ProbeStream {
  const stream = result.streams.find((candidate) => candidate.codec_type === "video");
  if (!stream) {
    throw new Error("Media file has no video stream.");
  }
  return stream;
}

function sha256(filePath: string): string {
  const hash = Crypto.createHash("sha256");
  hash.update(FileSystem.readFileSync(filePath));
  return hash.digest("hex");
}

async function getDevToolsTargets(port: number): Promise<ReadonlyArray<DevToolsTarget>> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`Electron debug endpoint returned ${String(response.status)}.`);
  }
  const value: unknown = await response.json();
  if (!Array.isArray(value)) {
    throw new Error("Electron debug endpoint returned an invalid target list.");
  }
  return value.filter(isRecord).map(
    (target): DevToolsTarget => ({
      id: typeof target.id === "string" ? target.id : "",
      title: typeof target.title === "string" ? target.title : "",
      type: typeof target.type === "string" ? target.type : "",
      url: typeof target.url === "string" ? target.url : "",
      webSocketDebuggerUrl:
        typeof target.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : undefined,
    }),
  );
}

function resolveMainTarget(targets: ReadonlyArray<DevToolsTarget>): DevToolsTarget {
  const target =
    targets.find(
      (candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl !== undefined &&
        candidate.url.includes("127.0.0.1:6066"),
    ) ??
    targets.find(
      (candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl !== undefined &&
        candidate.title.toLowerCase().includes("threadlines"),
    );
  if (!target) {
    throw new Error("Could not find the Threadlines renderer on the Electron debug endpoint.");
  }
  return target;
}

async function withCdp<T>(
  target: DevToolsTarget,
  use: (send: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Selected Electron target has no debugger WebSocket.");
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out connecting to Electron CDP.")),
      5_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Failed to connect to Electron CDP."));
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      readonly id?: number | undefined;
      readonly result?: unknown;
      readonly error?: { readonly message?: string | undefined } | undefined;
    };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? "Electron CDP command failed."));
    } else {
      waiter.resolve(message.result);
    }
  });

  const send = (method: string, params: unknown = {}): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  try {
    return await use(send);
  } finally {
    socket.close();
  }
}

function unwrapRuntimeValue(result: unknown): unknown {
  if (!isRecord(result) || !isRecord(result.result) || !("value" in result.result)) {
    throw new Error("Electron renderer returned no serializable runtime value.");
  }
  return result.result.value;
}

async function rendererSnapshot(manifest: CaptureManifest): Promise<{
  readonly snapshot: RuntimeSnapshot;
  readonly targets: ReadonlyArray<DevToolsTarget>;
  readonly target: DevToolsTarget;
}> {
  const targets = await getDevToolsTargets(manifest.capture.debugPort);
  const target = resolveMainTarget(targets);
  const value = await withCdp(target, async (send) =>
    unwrapRuntimeValue(
      await send("Runtime.evaluate", {
        expression: `(() => {
          const webview = document.querySelector("webview");
          let browserUrl = null;
          try {
            browserUrl = typeof webview?.getURL === "function" ? webview.getURL() : webview?.src ?? null;
          } catch {}
          const activeHeader = document.querySelector("[data-active-thread-title]");
          return {
            captureMode: window.desktopBridge?.isMarketingCaptureMode?.() === true,
            width: window.innerWidth,
            height: window.innerHeight,
            deviceScaleFactor: window.devicePixelRatio,
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            readyState: document.readyState,
            activeProjectName: activeHeader?.getAttribute("data-active-project-name") ?? null,
            activeThreadTitle: activeHeader?.getAttribute("data-active-thread-title") ?? null,
            text: document.body?.innerText ?? "",
            browserUrl,
            sourceControlOpen: document.querySelector('[aria-label="Source Control"]') !== null,
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }),
    ),
  );
  if (
    !isRecord(value) ||
    typeof value.captureMode !== "boolean" ||
    typeof value.width !== "number" ||
    typeof value.height !== "number" ||
    typeof value.deviceScaleFactor !== "number" ||
    (value.theme !== "light" && value.theme !== "dark") ||
    typeof value.readyState !== "string" ||
    (value.activeProjectName !== null && typeof value.activeProjectName !== "string") ||
    (value.activeThreadTitle !== null && typeof value.activeThreadTitle !== "string") ||
    typeof value.text !== "string" ||
    (value.browserUrl !== null && typeof value.browserUrl !== "string") ||
    typeof value.sourceControlOpen !== "boolean"
  ) {
    throw new Error("Electron renderer snapshot is invalid.");
  }
  return { snapshot: value as unknown as RuntimeSnapshot, targets, target };
}

function assertStudioSafety(paths: ReturnType<typeof studioPaths>): void {
  const metadataPath = NodePath.join(paths.root, STUDIO_METADATA_FILE);
  if (!FileSystem.existsSync(metadataPath)) {
    throw new Error(`Marketing Studio metadata is missing: ${metadataPath}`);
  }
  const metadata: unknown = JSON.parse(FileSystem.readFileSync(metadataPath, "utf8"));
  if (!isRecord(metadata) || metadata.kind !== "threadlines-marketing-studio") {
    throw new Error("Capture source is not an owned Threadlines Marketing Studio.");
  }

  const home = NodePath.resolve(NodeOS.homedir());
  if (
    !hasFlag("allow-personal-path") &&
    (NodePath.resolve(paths.root) === home ||
      NodePath.resolve(paths.root).startsWith(`${home}${NodePath.sep}`))
  ) {
    throw new Error(
      "Marketing Studio lives under the personal home directory. Move it to the neutral default path or pass --allow-personal-path after reviewing every visible path.",
    );
  }

  for (const project of EXPECTED_PROJECTS) {
    const projectPath = NodePath.join(paths.root, project);
    if (!FileSystem.existsSync(NodePath.join(projectPath, ".git"))) {
      throw new Error(`Publish-safe project is missing its isolated Git repository: ${project}`);
    }
    const remote = run("git", ["remote", "get-url", "origin"], { cwd: projectPath }).trim();
    if (!remote.startsWith("https://github.com/threadlines-labs/") && !remote.startsWith("file:")) {
      throw new Error(`Unexpected Git remote in ${project}; refusing to capture.`);
    }
    const email = run("git", ["config", "--get", "user.email"], { cwd: projectPath }).trim();
    if (!email.endsWith(".example")) {
      throw new Error(`Git author email in ${project} is not a reserved example address.`);
    }
    run("gitleaks", ["git", "--no-banner", "--redact=100", projectPath]);
  }
}

const waitForRenderer = async (
  manifest: CaptureManifest,
  predicate: (snapshot: RuntimeSnapshot) => boolean,
  failureMessage: string,
): Promise<RuntimeSnapshot> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const { snapshot } = await rendererSnapshot(manifest);
      if (predicate(snapshot)) {
        return snapshot;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  const errorDetail =
    lastError instanceof Error ? ` Last renderer error: ${lastError.message}` : "";
  throw new Error(`${failureMessage}${errorDetail}`);
};

async function selectSceneThread(manifest: CaptureManifest, scene: CaptureScene): Promise<void> {
  const { target } = await rendererSnapshot(manifest);
  const selected = await withCdp(target, async (send) =>
    unwrapRuntimeValue(
      await send("Runtime.evaluate", {
        expression: `(async () => {
          const desiredTitle = ${JSON.stringify(scene.threadTitle)};
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const title = Array.from(
              document.querySelectorAll(
                '[data-testid^="thread-title-"], [data-testid^="done-title-"]',
              ),
            ).find((candidate) => candidate.textContent?.trim() === desiredTitle);
            const row = title?.closest(
              '[data-testid^="thread-row-"], [data-testid^="done-row-"]',
            );
            if (row instanceof HTMLElement) {
              row.click();
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return false;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }),
    ),
  );
  if (selected !== true) {
    throw new Error(
      `Could not find '${scene.threadTitle}' in the visible studio sidebar. Reveal the thread and run prepare again.`,
    );
  }
  await waitForRenderer(
    manifest,
    (snapshot) =>
      snapshot.activeProjectName === scene.project &&
      snapshot.activeThreadTitle === scene.threadTitle,
    `Threadlines did not open '${scene.threadTitle}' in ${scene.project}.`,
  );
}

async function arrangeSceneBrowser(manifest: CaptureManifest, scene: CaptureScene): Promise<void> {
  const { target } = await rendererSnapshot(manifest);
  const arrangement = await withCdp(target, async (send) =>
    unwrapRuntimeValue(
      await send("Runtime.evaluate", {
        expression: `(async () => {
          const desiredUrl = ${JSON.stringify(scene.browserUrl ?? null)};
          const toggle = document.querySelector('[aria-label="Toggle browser preview"]');
          let panel = document.querySelector('[data-testid="browser-panel"]');
          if (desiredUrl === null) {
            if (panel instanceof HTMLElement && toggle instanceof HTMLElement) toggle.click();
            return { browserExpected: false, panelFound: panel !== null };
          }
          if (panel === null && toggle instanceof HTMLElement) {
            toggle.click();
            for (let attempt = 0; attempt < 30; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              panel = document.querySelector('[data-testid="browser-panel"]');
              if (panel !== null) break;
            }
          }
          const webview = document.querySelector('webview');
          if (typeof webview?.loadURL !== "function") {
            return { browserExpected: true, panelFound: panel !== null, webviewFound: false };
          }
          try {
            await webview.loadURL(desiredUrl);
          } catch {
            const currentUrl =
              typeof webview.getURL === "function" ? webview.getURL() : webview.src ?? "";
            if (!currentUrl.startsWith(desiredUrl)) throw new Error("Browser navigation failed.");
          }
          await webview.executeJavaScript('window.scrollTo({ top: 0, behavior: "instant" })');
          return { browserExpected: true, panelFound: panel !== null, webviewFound: true };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }),
    ),
  );
  if (
    scene.browserUrl &&
    (!isRecord(arrangement) || arrangement.panelFound !== true || arrangement.webviewFound !== true)
  ) {
    throw new Error("Could not open the Threadlines browser panel for this scene.");
  }
  if (scene.browserUrl) {
    await waitForRenderer(
      manifest,
      (snapshot) => snapshot.browserUrl?.startsWith(scene.browserUrl ?? "never") === true,
      `The browser panel did not finish opening ${scene.browserUrl}.`,
    );
  }
}

async function arrangeSceneSourceControl(
  manifest: CaptureManifest,
  scene: CaptureScene,
): Promise<void> {
  const { target } = await rendererSnapshot(manifest);
  const arrangement = await withCdp(target, async (send) =>
    unwrapRuntimeValue(
      await send("Runtime.evaluate", {
        expression: `(() => {
          const desiredOpen = ${JSON.stringify(scene.sourceControlOpen)};
          const panelOpen = document.querySelector('[aria-label="Source Control"]') !== null;
          const toggle = document.querySelector('[aria-label="Toggle source control panel"]');
          if (panelOpen !== desiredOpen && toggle instanceof HTMLElement) toggle.click();
          return { desiredOpen, panelOpen, toggleFound: toggle !== null };
        })()`,
        returnByValue: true,
      }),
    ),
  );
  if (!isRecord(arrangement) || arrangement.toggleFound !== true) {
    throw new Error("Could not find the Threadlines source control toggle for this scene.");
  }
  await waitForRenderer(
    manifest,
    (snapshot) => snapshot.sourceControlOpen === scene.sourceControlOpen,
    `The source control panel did not finish ${scene.sourceControlOpen ? "opening" : "closing"}.`,
  );
}

async function prepare(): Promise<void> {
  const manifest = readManifest();
  const scene = resolveScene(manifest);
  const { target } = await rendererSnapshot(manifest);
  await withCdp(target, async (send) => {
    await send("Runtime.evaluate", {
      expression: `(() => {
        localStorage.setItem("threadlines:theme", ${JSON.stringify(scene.theme)});
        sessionStorage.setItem("threadlines:marketing-capture-scene", ${JSON.stringify(scene.id)});
        location.reload();
        return true;
      })()`,
      returnByValue: true,
    });
  });
  await waitForRenderer(
    manifest,
    (snapshot) => snapshot.readyState === "complete" && snapshot.theme === scene.theme,
    `Threadlines did not finish switching to ${scene.theme} theme.`,
  );
  await selectSceneThread(manifest, scene);
  await arrangeSceneBrowser(manifest, scene);
  await arrangeSceneSourceControl(manifest, scene);
  console.log(`Prepared ${scene.id}: ${scene.theme} theme.`);
  console.log(`Active thread:    ${scene.threadTitle} in ${scene.project}`);
  console.log(`Browser panel:    ${scene.browserUrl ?? "closed"}`);
  console.log(`Source control:   ${scene.sourceControlOpen ? "open" : "closed"}`);
  console.log(`Cursor:           ${scene.cursorMode}`);
  console.log("Review the frame, then run preflight.");
}

async function evaluateRenderer(manifest: CaptureManifest, expression: string): Promise<unknown> {
  const { target } = await rendererSnapshot(manifest);
  return withCdp(target, async (send) =>
    unwrapRuntimeValue(
      await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
    ),
  );
}

async function evaluateBrowser(manifest: CaptureManifest, expression: string): Promise<unknown> {
  return evaluateRenderer(
    manifest,
    `(async () => {
      const webview = document.querySelector("webview");
      if (typeof webview?.executeJavaScript !== "function") {
        throw new Error("The browser webview is unavailable.");
      }
      return await webview.executeJavaScript(${JSON.stringify(expression)});
    })()`,
  );
}

async function clickVisibleThread(manifest: CaptureManifest, title: string): Promise<void> {
  const clicked = await evaluateRenderer(
    manifest,
    `(() => {
      const desiredTitle = ${JSON.stringify(title)};
      const titleElement = Array.from(
        document.querySelectorAll('[data-testid^="thread-title-"], [data-testid^="done-title-"]'),
      ).find((candidate) => candidate.textContent?.trim() === desiredTitle);
      const row = titleElement?.closest(
        '[data-testid^="thread-row-"], [data-testid^="done-row-"]',
      );
      if (!(row instanceof HTMLElement)) return false;
      row.click();
      return true;
    })()`,
  );
  if (clicked !== true) {
    throw new Error(`Could not click '${title}' during the sidebar take.`);
  }
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

interface CapturePoint {
  readonly x: number;
  readonly y: number;
}

function parseCapturePoint(value: unknown, label: string): CapturePoint {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y)
  ) {
    throw new Error(`Could not resolve the ${label} position for the capture.`);
  }
  return { x: value.x, y: value.y };
}

async function rendererElementCenter(
  manifest: CaptureManifest,
  selector: string,
  label: string,
): Promise<CapturePoint> {
  const point = await evaluateRenderer(
    manifest,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`,
  );
  return parseCapturePoint(point, label);
}

async function browserElementCenter(
  manifest: CaptureManifest,
  selector: string,
  label: string,
): Promise<CapturePoint> {
  const webviewOrigin = parseCapturePoint(
    await evaluateRenderer(
      manifest,
      `(() => {
        const webview = document.querySelector("webview");
        if (!(webview instanceof HTMLElement)) return null;
        const bounds = webview.getBoundingClientRect();
        return { x: bounds.left, y: bounds.top };
      })()`,
    ),
    "browser viewport",
  );
  const pagePoint = parseCapturePoint(
    await evaluateBrowser(
      manifest,
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return null;
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      })()`,
    ),
    label,
  );
  return {
    x: webviewOrigin.x + pagePoint.x,
    y: webviewOrigin.y + pagePoint.y,
  };
}

async function clickRendererElement(
  manifest: CaptureManifest,
  selector: string,
  label: string,
): Promise<void> {
  const clicked = await evaluateRenderer(
    manifest,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
  );
  if (clicked !== true) {
    throw new Error(`Could not activate the ${label} during the capture.`);
  }
}

async function clickBrowserElement(
  manifest: CaptureManifest,
  selector: string,
  label: string,
): Promise<void> {
  const clicked = await evaluateBrowser(
    manifest,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
  );
  if (clicked !== true) {
    throw new Error(`Could not activate the ${label} during the capture.`);
  }
}

async function waitForRendererCondition(
  manifest: CaptureManifest,
  expression: string,
  failureMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await evaluateRenderer(manifest, expression)) === true) return;
    await wait(100);
  }
  throw new Error(failureMessage);
}

async function waitForBrowserCondition(
  manifest: CaptureManifest,
  expression: string,
  failureMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await evaluateBrowser(manifest, expression)) === true) return;
    await wait(100);
  }
  throw new Error(failureMessage);
}

async function browserShadowElementCenter(
  manifest: CaptureManifest,
  hostSelector: string,
  shadowSelector: string,
  label: string,
): Promise<CapturePoint> {
  const webviewOrigin = parseCapturePoint(
    await evaluateRenderer(
      manifest,
      `(() => {
        const webview = document.querySelector("webview");
        if (!(webview instanceof HTMLElement)) return null;
        const bounds = webview.getBoundingClientRect();
        return { x: bounds.left, y: bounds.top };
      })()`,
    ),
    "browser viewport",
  );
  const pagePoint = parseCapturePoint(
    await evaluateBrowser(
      manifest,
      `(() => {
        const host = document.querySelector(${JSON.stringify(hostSelector)});
        const element = host?.shadowRoot?.querySelector(${JSON.stringify(shadowSelector)});
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return null;
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      })()`,
    ),
    label,
  );
  return {
    x: webviewOrigin.x + pagePoint.x,
    y: webviewOrigin.y + pagePoint.y,
  };
}

async function pickBrowserElement(
  manifest: CaptureManifest,
  selector: string,
  label: string,
): Promise<void> {
  const picked = await evaluateBrowser(
    manifest,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        view: window,
      }));
      return true;
    })()`,
  );
  if (picked !== true) {
    throw new Error(`Could not pick the ${label} during the capture.`);
  }
}

async function typeBrowserShadowInput(
  manifest: CaptureManifest,
  hostSelector: string,
  shadowSelector: string,
  text: string,
): Promise<void> {
  const typed = await evaluateBrowser(
    manifest,
    `(async () => {
      const host = document.querySelector(${JSON.stringify(hostSelector)});
      const input = host?.shadowRoot?.querySelector(${JSON.stringify(shadowSelector)});
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus();
      input.value = "";
      for (const character of ${JSON.stringify(text)}) {
        input.setRangeText(character, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, "end");
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          data: character,
          inputType: "insertText",
        }));
        await new Promise((resolve) => setTimeout(resolve, 24));
      }
      return true;
    })()`,
  );
  if (typed !== true) {
    throw new Error("Could not type the browser annotation during the capture.");
  }
}

async function clickBrowserShadowElement(
  manifest: CaptureManifest,
  hostSelector: string,
  shadowSelector: string,
  label: string,
): Promise<void> {
  const clicked = await evaluateBrowser(
    manifest,
    `(() => {
      const host = document.querySelector(${JSON.stringify(hostSelector)});
      const element = host?.shadowRoot?.querySelector(${JSON.stringify(shadowSelector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
  );
  if (clicked !== true) {
    throw new Error(`Could not activate the ${label} during the capture.`);
  }
}

async function typeRendererText(
  manifest: CaptureManifest,
  selector: string,
  text: string,
  label: string,
): Promise<void> {
  const { target } = await rendererSnapshot(manifest);
  const focused = await withCdp(target, async (send) => {
    const result = unwrapRuntimeValue(
      await send("Runtime.evaluate", {
        expression: `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!(element instanceof HTMLElement)) return false;
          element.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
          return true;
        })()`,
        returnByValue: true,
      }),
    );
    if (result !== true) return false;
    for (const character of text) {
      await send("Input.insertText", { text: character });
      await wait(18);
    }
    return true;
  });
  if (!focused) {
    throw new Error(`Could not type into the ${label} during the capture.`);
  }
}

async function clearRendererComposer(manifest: CaptureManifest): Promise<void> {
  const { target } = await rendererSnapshot(manifest);
  await withCdp(target, async (send) => {
    const focused = unwrapRuntimeValue(
      await send("Runtime.evaluate", {
        expression: `(() => {
          const element = document.querySelector('[data-testid="composer-editor"]');
          if (!(element instanceof HTMLElement)) return false;
          element.focus();
          return true;
        })()`,
        returnByValue: true,
      }),
    );
    if (focused !== true) return;
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: 4,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 4,
    });
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });
  });
}

function parseCaptureRectangle(value: unknown, label: string): CaptureRectangle {
  if (!isRecord(value)) {
    throw new Error(`The capture-window helper returned invalid ${label}.`);
  }
  const rectangle = {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
  if (
    !Number.isInteger(rectangle.x) ||
    !Number.isInteger(rectangle.y) ||
    !Number.isInteger(rectangle.width) ||
    !Number.isInteger(rectangle.height) ||
    (rectangle.width as number) <= 0 ||
    (rectangle.height as number) <= 0
  ) {
    throw new Error(`The capture-window helper returned invalid ${label}.`);
  }
  return rectangle as CaptureRectangle;
}

function captureWindowInfo(manifest: CaptureManifest): CaptureWindowInfo {
  if (process.platform !== "darwin") {
    throw new Error("Automated window recording currently requires macOS.");
  }
  const helper = NodePath.join(
    REPO_ROOT,
    "scripts",
    "fixtures",
    "marketing-studio",
    "find-capture-window.swift",
  );
  const rawResult = JSON.parse(
    run("swift", [
      helper,
      String(manifest.geometry.logicalWidth),
      String(manifest.geometry.logicalHeight),
    ]),
  ) as unknown;
  if (
    !isRecord(rawResult) ||
    !Number.isInteger(rawResult.windowId) ||
    !Array.isArray(rawResult.displays)
  ) {
    throw new Error("The capture-window helper returned an invalid result.");
  }
  return {
    windowId: rawResult.windowId as number,
    bounds: parseCaptureRectangle(rawResult.bounds, "window bounds"),
    displays: rawResult.displays.map((display, index) =>
      parseCaptureRectangle(display, `display bounds at index ${String(index)}`),
    ),
  };
}

export function assertCaptureWindowFullyVisible(input: CaptureWindowInfo): void {
  const windowRight = input.bounds.x + input.bounds.width;
  const windowBottom = input.bounds.y + input.bounds.height;
  const containingDisplay = input.displays.find((display) => {
    const displayRight = display.x + display.width;
    const displayBottom = display.y + display.height;
    return (
      input.bounds.x >= display.x &&
      input.bounds.y >= display.y &&
      windowRight <= displayRight &&
      windowBottom <= displayBottom
    );
  });
  if (containingDisplay) return;

  const displays = input.displays
    .map(
      (display) =>
        `${String(display.width)}×${String(display.height)} at ${String(display.x)},${String(display.y)}`,
    )
    .join("; ");
  throw new Error(
    `Capture window ${String(input.bounds.width)}×${String(input.bounds.height)} at ${String(input.bounds.x)},${String(input.bounds.y)} extends beyond every display (${displays}). macOS would pad the off-screen edge black. Choose a display mode with at least 1600×934 usable points, then relaunch the studio.`,
  );
}

function moveNativePointer(x: number, y: number, durationSeconds: number): void {
  const helper = NodePath.join(
    REPO_ROOT,
    "scripts",
    "fixtures",
    "marketing-studio",
    "move-native-pointer.swift",
  );
  run("swift", [helper, String(x), String(y), String(durationSeconds)]);
}

async function performSceneActions(
  manifest: CaptureManifest,
  scene: CaptureScene,
  windowBounds: CaptureRectangle,
): Promise<void> {
  const sceneFamily = scene.id.replace(/-(?:dark|light)$/, "");
  switch (sceneFamily) {
    case "workspace-four-panel-overview": {
      moveNativePointer(10, 10, 0);
      await wait(1_200);

      const collapseQuestions = await rendererElementCenter(
        manifest,
        'button[aria-label="Collapse questions"]',
        "collapse questions button",
      );
      moveNativePointer(
        windowBounds.x + collapseQuestions.x,
        windowBounds.y + collapseQuestions.y,
        0.8,
      );
      await clickRendererElement(
        manifest,
        'button[aria-label="Collapse questions"]',
        "collapse questions button",
      );
      await wait(800);

      const activityButton = await browserElementCenter(
        manifest,
        ".launch-button",
        "browser activity button",
      );
      moveNativePointer(windowBounds.x + activityButton.x, windowBounds.y + activityButton.y, 1);
      await clickBrowserElement(manifest, ".launch-button", "browser activity button");
      await wait(1_000);
      await evaluateBrowser(
        manifest,
        `(() => {
          window.scrollTo({ top: 520, behavior: "smooth" });
          return true;
        })()`,
      );
      await wait(1_600);
      await evaluateBrowser(
        manifest,
        `(() => {
          window.scrollTo({ top: 0, behavior: "smooth" });
          return true;
        })()`,
      );
      await wait(800);

      const changedFile = await rendererElementCenter(
        manifest,
        'button[aria-label="Open diff for src/theme.ts"]',
        "source-control file",
      );
      moveNativePointer(windowBounds.x + changedFile.x, windowBounds.y + changedFile.y, 1);
      await clickRendererElement(
        manifest,
        'button[aria-label="Open diff for src/theme.ts"]',
        "source-control file",
      );
      await wait(2_400);

      const backToSourceControl = await rendererElementCenter(
        manifest,
        'button[aria-label="Back to source control"]',
        "back to source control button",
      );
      moveNativePointer(
        windowBounds.x + backToSourceControl.x,
        windowBounds.y + backToSourceControl.y,
        0.8,
      );
      await clickRendererElement(
        manifest,
        'button[aria-label="Back to source control"]',
        "back to source control button",
      );
      await wait(1_000);

      const expandQuestions = await rendererElementCenter(
        manifest,
        'button[aria-label="Expand questions"]',
        "expand questions button",
      );
      moveNativePointer(
        windowBounds.x + expandQuestions.x,
        windowBounds.y + expandQuestions.y,
        0.8,
      );
      await clickRendererElement(
        manifest,
        'button[aria-label="Expand questions"]',
        "expand questions button",
      );
      await wait(800);
      await evaluateBrowser(
        manifest,
        `(() => {
          const button = document.querySelector(".launch-button");
          if (!(button instanceof HTMLElement)) return false;
          button.click();
          window.scrollTo({ top: 0, behavior: "instant" });
          return true;
        })()`,
      );
      await wait(300);
      moveNativePointer(10, 10, 1);
      return;
    }
    case "sidebar-attention-states": {
      await wait(1_400);
      await clickVisibleThread(manifest, "Project file editing");
      await wait(300);
      await arrangeSceneBrowser(manifest, { ...scene, browserUrl: undefined });
      await arrangeSceneSourceControl(manifest, { ...scene, sourceControlOpen: false });
      await wait(1_200);
      await clickVisibleThread(manifest, "Deploy health");
      await wait(300);
      await arrangeSceneBrowser(manifest, { ...scene, browserUrl: undefined });
      await arrangeSceneSourceControl(manifest, { ...scene, sourceControlOpen: false });
      await wait(1_200);
      await clickVisibleThread(manifest, "Checkout recovery");
      return;
    }
    case "agent-browser-workflow": {
      const pickOverlay = "#__threadlines-pick-overlay";
      const annotationTarget = ".readiness h2";
      const annotationNote = "Make this a compact green status banner.";
      const composerPrompt = "Apply this treatment and keep the health details below.";

      await evaluateBrowser(
        manifest,
        `(() => {
          if (typeof window.__threadlinesResetAnnotationDemo !== "function") return false;
          window.__threadlinesResetAnnotationDemo();
          return true;
        })()`,
      );
      await evaluateRenderer(
        manifest,
        `(() => {
          for (const button of document.querySelectorAll('[data-testid^="picked-element-remove-"]')) {
            if (button instanceof HTMLElement) button.click();
          }
          return true;
        })()`,
      );
      await clearRendererComposer(manifest);
      moveNativePointer(10, 10, 0);
      await wait(1_200);

      const annotateTool = await rendererElementCenter(
        manifest,
        '[data-testid="browser-page-tool-arm"]',
        "browser annotate tool",
      );
      moveNativePointer(windowBounds.x + annotateTool.x, windowBounds.y + annotateTool.y, 0.75);
      await clickRendererElement(
        manifest,
        '[data-testid="browser-page-tool-arm"]',
        "browser annotate tool",
      );
      await waitForBrowserCondition(
        manifest,
        `document.querySelector(${JSON.stringify(pickOverlay)}) !== null`,
        "The browser annotation overlay did not appear.",
      );
      await wait(300);

      const targetHeading = await browserElementCenter(
        manifest,
        annotationTarget,
        "service-health heading",
      );
      moveNativePointer(windowBounds.x + targetHeading.x, windowBounds.y + targetHeading.y, 0.85);
      await pickBrowserElement(manifest, annotationTarget, "service-health heading");
      await waitForBrowserCondition(
        manifest,
        `document.querySelector(${JSON.stringify(pickOverlay)})?.shadowRoot?.querySelector(".input") !== null`,
        "The browser annotation note field did not appear.",
      );
      await wait(250);
      await typeBrowserShadowInput(manifest, pickOverlay, ".input", annotationNote);
      await wait(450);

      const attachButton = await browserShadowElementCenter(
        manifest,
        pickOverlay,
        ".attach",
        "annotation attach button",
      );
      moveNativePointer(windowBounds.x + attachButton.x, windowBounds.y + attachButton.y, 0.65);
      await clickBrowserShadowElement(manifest, pickOverlay, ".attach", "annotation attach button");
      await waitForRendererCondition(
        manifest,
        `document.querySelector('[data-testid="picked-element-chips"]') !== null`,
        "The picked browser element was not attached to the composer.",
      );
      await wait(450);

      const composer = await rendererElementCenter(
        manifest,
        '[data-testid="composer-editor"]',
        "message composer",
      );
      moveNativePointer(windowBounds.x + composer.x, windowBounds.y + composer.y, 0.65);
      await typeRendererText(
        manifest,
        '[data-testid="composer-editor"]',
        composerPrompt,
        "message composer",
      );
      await waitForRendererCondition(
        manifest,
        `document.querySelector('[data-testid="composer-editor"]')?.textContent?.includes(${JSON.stringify(composerPrompt)}) === true`,
        "The annotation follow-up did not appear in the composer.",
      );
      await wait(1_100);

      await clearRendererComposer(manifest);
      await evaluateRenderer(
        manifest,
        `(() => {
          const remove = document.querySelector('[data-testid^="picked-element-remove-"]');
          if (!(remove instanceof HTMLElement)) return false;
          remove.click();
          return true;
        })()`,
      );
      await evaluateBrowser(
        manifest,
        `(() => {
          if (typeof window.__threadlinesApplyAnnotationDemo !== "function") return false;
          window.__threadlinesApplyAnnotationDemo();
          return true;
        })()`,
      );
      moveNativePointer(10, 10, 0.8);
      await waitForBrowserCondition(
        manifest,
        `document.querySelector(".readiness")?.dataset.agentState === "applied"`,
        "The simulated agent change did not reach the live preview.",
      );
      await wait(5_000);
      return;
    }
    default:
      throw new Error(`Scene '${scene.id}' does not have an automated motion take.`);
  }
}

async function record(): Promise<void> {
  const manifest = readManifest();
  const { scene, captureWindow } = await preflight({ quiet: true });
  if (scene.kind !== "motion" || scene.durationSeconds === undefined) {
    throw new Error(`Scene '${scene.id}' is not a motion scene.`);
  }
  if (!captureWindow) {
    throw new Error("Automated recording requires a verified macOS capture window.");
  }
  const paths = studioPaths();
  FileSystem.mkdirSync(paths.rawMasters, { recursive: true });
  FileSystem.mkdirSync(paths.masters, { recursive: true });

  const rawPath = NodePath.join(
    paths.rawMasters,
    `${scene.id}-screen-${new Date().toISOString().replaceAll(":", "-")}.mov`,
  );
  const masterPath = NodePath.join(paths.masters, `${scene.id}.mkv`);
  const captureArgs = [
    "-x",
    "-v",
    "-o",
    ...(scene.cursorMode === "native" ? ["-C"] : []),
    `-l${String(captureWindow.windowId)}`,
    `-V${String(scene.durationSeconds)}`,
    rawPath,
  ];

  if (scene.cursorMode === "native") {
    moveNativePointer(10, 10, 0);
  }

  console.log(`Recording ${scene.id} for ${String(scene.durationSeconds)} seconds...`);
  const capture = ChildProcess.spawn("screencapture", captureArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const captureResult = new Promise<void>((resolve, reject) => {
    let stderr = "";
    capture.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    capture.once("error", reject);
    capture.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `macOS window recording failed with code ${String(code)}${
              stderr.trim() ? `:\n${stderr.trim().slice(-4_000)}` : ""
            }`,
          ),
        );
      }
    });
  });

  let actionError: unknown;
  try {
    await performSceneActions(manifest, scene, captureWindow.bounds);
  } catch (error) {
    actionError = error;
  }
  await captureResult;
  if (actionError !== undefined) throw actionError;

  run("ffmpeg", [
    "-y",
    "-i",
    rawPath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=${String(manifest.geometry.framesPerSecond)},format=yuv444p10le`,
    "-c:v",
    "ffv1",
    "-level",
    "3",
    "-coder",
    "1",
    "-context",
    "1",
    "-g",
    "1",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    masterPath,
  ]);
  const master = assertMaster(masterPath, manifest);
  console.log(
    `Recorded CFR master: ${masterPath} (${master.duration.toFixed(2)}s, ${String(master.stream.width)}×${String(master.stream.height)})`,
  );
}

async function preflight(options: { readonly quiet?: boolean } = {}): Promise<{
  readonly scene: CaptureScene;
  readonly snapshot: RuntimeSnapshot;
  readonly captureWindow: CaptureWindowInfo | undefined;
}> {
  const manifest = readManifest();
  const scene = resolveScene(manifest);
  const paths = studioPaths();

  for (const command of ["ffmpeg", "ffprobe", "gitleaks"]) {
    if (!commandExists(command)) {
      throw new Error(`Required capture tool is not installed: ${command}`);
    }
  }
  assertStudioSafety(paths);

  const demoResponse = await fetch(manifest.capture.demoUrl, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!demoResponse.ok) {
    throw new Error(`Orbit demo returned ${String(demoResponse.status)}.`);
  }

  const { snapshot, targets } = await rendererSnapshot(manifest);
  const expectsCaptureMode = scene.windowMode === "neutral";
  if (snapshot.captureMode !== expectsCaptureMode) {
    throw new Error(
      scene.windowMode === "neutral"
        ? "Scene requires the neutral capture window. Launch with `vp run marketing:studio`."
        : "Scene requires genuine native controls. Launch with `vp run marketing:studio:native`.",
    );
  }
  if (
    expectsCaptureMode &&
    (snapshot.width !== manifest.geometry.logicalWidth ||
      snapshot.height !== manifest.geometry.logicalHeight)
  ) {
    throw new Error(
      `Renderer is ${snapshot.width}×${snapshot.height}; expected ${manifest.geometry.logicalWidth}×${manifest.geometry.logicalHeight}.`,
    );
  }
  if (
    expectsCaptureMode &&
    Math.abs(snapshot.deviceScaleFactor - manifest.geometry.deviceScaleFactor) > 0.01
  ) {
    throw new Error(
      `Display scale is ${snapshot.deviceScaleFactor}×; expected ${manifest.geometry.deviceScaleFactor}×. Move Threadlines to a Retina/HiDPI display and relaunch.`,
    );
  }
  const captureWindow =
    expectsCaptureMode && scene.kind === "motion" && process.platform === "darwin"
      ? captureWindowInfo(manifest)
      : undefined;
  if (captureWindow) {
    assertCaptureWindowFullyVisible(captureWindow);
  }
  if (snapshot.theme !== scene.theme) {
    throw new Error(
      `Scene requires ${scene.theme} theme, but Threadlines is ${snapshot.theme}. Run capture:prepare first.`,
    );
  }
  if (
    snapshot.activeProjectName !== scene.project ||
    snapshot.activeThreadTitle !== scene.threadTitle
  ) {
    const activeContext =
      snapshot.activeProjectName && snapshot.activeThreadTitle
        ? `'${snapshot.activeThreadTitle}' in ${snapshot.activeProjectName}`
        : "no active thread";
    throw new Error(
      `Scene requires '${scene.threadTitle}' in ${scene.project}, but the renderer has ${activeContext}.`,
    );
  }
  const missingLabels = scene.expectedLabels.filter((label) => !snapshot.text.includes(label));
  if (missingLabels.length > 0) {
    throw new Error(
      `Scene is not arranged yet; missing visible labels: ${missingLabels.join(", ")}`,
    );
  }
  if (scene.browserUrl) {
    const visibleBrowserUrl =
      snapshot.browserUrl ??
      targets.find((target) => target.url.startsWith(scene.browserUrl ?? "never"))?.url ??
      null;
    if (!visibleBrowserUrl?.startsWith(scene.browserUrl)) {
      throw new Error(`Browser scene requires ${scene.browserUrl}; open it before recording.`);
    }
  }
  if (snapshot.sourceControlOpen !== scene.sourceControlOpen) {
    throw new Error(
      `Scene requires source control ${scene.sourceControlOpen ? "open" : "closed"}; run capture:prepare first.`,
    );
  }

  FileSystem.mkdirSync(paths.qa, { recursive: true });
  const gitSha = run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).trim();
  const reportPath = NodePath.join(paths.qa, `${scene.id}-preflight.json`);
  FileSystem.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        sceneId: scene.id,
        release: manifest.release,
        checkedAt: new Date().toISOString(),
        gitSha,
        platform: process.platform,
        cursorMode: scene.cursorMode,
        captureWindow,
        snapshot: {
          captureMode: snapshot.captureMode,
          width: snapshot.width,
          height: snapshot.height,
          deviceScaleFactor: snapshot.deviceScaleFactor,
          theme: snapshot.theme,
          activeProjectName: snapshot.activeProjectName,
          activeThreadTitle: snapshot.activeThreadTitle,
          browserUrl: snapshot.browserUrl,
          sourceControlOpen: snapshot.sourceControlOpen,
        },
      },
      null,
      2,
    )}\n`,
  );
  if (!options.quiet) {
    console.log(`Preflight passed for ${scene.id}.`);
    console.log(
      `Geometry:         ${snapshot.width}×${snapshot.height} at ${snapshot.deviceScaleFactor}×`,
    );
    console.log(`Capture window:   ${scene.windowMode}`);
    console.log(`Safety report:    ${reportPath}`);
  }
  return { scene, snapshot, captureWindow };
}

function pngDimensions(buffer: Buffer): { readonly width: number; readonly height: number } {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Captured still is not a valid PNG.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function still(): Promise<void> {
  const manifest = readManifest();
  const { scene, snapshot } = await preflight({ quiet: true });
  if (scene.windowMode === "native") {
    throw new Error(
      "CDP captures renderer content only. Capture native platform proof with an OS/OBS window source so genuine controls remain visible.",
    );
  }
  const paths = studioPaths();
  const { target } = await rendererSnapshot(manifest);
  const capture = await withCdp(target, async (send) =>
    send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    }),
  );
  if (!isRecord(capture) || typeof capture.data !== "string") {
    throw new Error("Electron did not return PNG screenshot data.");
  }
  const buffer = Buffer.from(capture.data, "base64");
  const dimensions = pngDimensions(buffer);
  if (
    dimensions.width !== manifest.geometry.masterWidth ||
    dimensions.height !== manifest.geometry.masterHeight
  ) {
    throw new Error(
      `Captured PNG is ${dimensions.width}×${dimensions.height}; expected ${manifest.geometry.masterWidth}×${manifest.geometry.masterHeight}.`,
    );
  }

  FileSystem.mkdirSync(paths.masters, { recursive: true });
  const outputPath = NodePath.join(paths.masters, `${scene.id}.png`);
  FileSystem.writeFileSync(outputPath, buffer);
  FileSystem.writeFileSync(
    `${outputPath}.json`,
    `${JSON.stringify(
      {
        sceneId: scene.id,
        capturedAt: new Date().toISOString(),
        width: dimensions.width,
        height: dimensions.height,
        deviceScaleFactor: snapshot.deviceScaleFactor,
        sha256: sha256(outputPath),
        sourceRevision: run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).trim(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Captured clean still: ${outputPath}`);
}

function sourceMediaPath(scene: CaptureScene, paths: ReturnType<typeof studioPaths>): string {
  const configured = argument("input");
  if (configured) return NodePath.resolve(configured);
  for (const extension of ["mov", "mkv"]) {
    const candidate = NodePath.join(paths.masters, `${scene.id}.${extension}`);
    if (FileSystem.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No source master found for ${scene.id}. Pass --input or place ${scene.id}.mov/.mkv in ${paths.masters}.`,
  );
}

function assertMaster(
  sourcePath: string,
  manifest: CaptureManifest,
): { readonly duration: number; readonly stream: ProbeStream } {
  const result = probe(sourcePath);
  const stream = videoStream(result);
  if (
    stream.width !== manifest.geometry.masterWidth ||
    stream.height !== manifest.geometry.masterHeight
  ) {
    throw new Error(
      `Master is ${String(stream.width)}×${String(stream.height)}; expected ${manifest.geometry.masterWidth}×${manifest.geometry.masterHeight}.`,
    );
  }
  const averageFps = frameRate(stream.avg_frame_rate);
  const nominalFps = frameRate(stream.r_frame_rate);
  if (
    Math.abs(averageFps - manifest.geometry.framesPerSecond) > 0.02 ||
    Math.abs(nominalFps - manifest.geometry.framesPerSecond) > 0.02
  ) {
    throw new Error(
      `Master is not true ${manifest.geometry.framesPerSecond} fps CFR (nominal ${nominalFps.toFixed(3)}, average ${averageFps.toFixed(3)}).`,
    );
  }
  if (
    !hasFlag("allow-compressed-master") &&
    stream.codec_name === "h264" &&
    stream.pix_fmt === "yuv420p"
  ) {
    throw new Error(
      "Master is H.264 4:2:0. Record ProRes 422 HQ or FFV1/lossless-quality source, or pass --allow-compressed-master after visual review.",
    );
  }
  const duration = Number(result.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Master duration is missing or invalid.");
  }
  return { duration, stream };
}

function encodeVideo(input: {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly codec: "h264" | "vp9";
  readonly framesPerSecond: number;
  readonly keyframeSeconds: number;
}): void {
  const keyframeFrames = Math.round(input.framesPerSecond * input.keyframeSeconds);
  const common = [
    "-y",
    "-i",
    input.sourcePath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=${input.framesPerSecond},scale=${input.width}:${input.height}:flags=lanczos,setsar=1,format=yuv420p`,
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-g",
    String(keyframeFrames),
  ];
  const codecArgs =
    input.codec === "h264"
      ? [
          "-c:v",
          "libx264",
          "-preset",
          "slow",
          "-crf",
          "18",
          "-profile:v",
          "high",
          "-keyint_min",
          String(keyframeFrames),
          "-sc_threshold",
          "0",
          "-movflags",
          "+faststart",
        ]
      : [
          "-c:v",
          "libvpx-vp9",
          "-b:v",
          "0",
          "-crf",
          "30",
          "-deadline",
          "good",
          "-cpu-used",
          "2",
          "-row-mt",
          "1",
          "-tile-columns",
          "2",
        ];
  run("ffmpeg", [...common, ...codecArgs, input.outputPath]);
}

function extractQaFrames(input: {
  readonly sourcePath: string;
  readonly sceneId: string;
  readonly duration: number;
  readonly qaDirectory: string;
}): void {
  FileSystem.mkdirSync(input.qaDirectory, { recursive: true });
  const positions = [
    { name: "first", seconds: 0 },
    { name: "middle", seconds: input.duration / 2 },
    { name: "last", seconds: Math.max(0, input.duration - 1 / 60) },
  ];
  for (const position of positions) {
    run("ffmpeg", [
      "-y",
      "-ss",
      position.seconds.toFixed(3),
      "-i",
      input.sourcePath,
      "-frames:v",
      "1",
      NodePath.join(input.qaDirectory, `${input.sceneId}-${position.name}.png`),
    ]);
  }
  run("ffmpeg", [
    "-y",
    "-i",
    input.sourcePath,
    "-vf",
    "fps=1/2,scale=640:-2:flags=lanczos,tile=4x2:padding=2:margin=0",
    "-frames:v",
    "1",
    NodePath.join(input.qaDirectory, `${input.sceneId}-contact-sheet.png`),
  ]);
}

async function exportMedia(): Promise<void> {
  const manifest = readManifest();
  const scene = resolveScene(manifest);
  if (scene.kind !== "motion") {
    throw new Error(`Scene '${scene.id}' is a still; it has no motion exports.`);
  }
  const paths = studioPaths();
  const sourcePath = sourceMediaPath(scene, paths);
  if (!FileSystem.existsSync(sourcePath)) {
    throw new Error(`Source master does not exist: ${sourcePath}`);
  }
  const master = assertMaster(sourcePath, manifest);
  const outputDirectory = NodePath.resolve(
    argument("output-dir") ?? NodePath.join(paths.exports, manifest.release, scene.id),
  );
  const posterDirectory = NodePath.join(paths.posters, manifest.release);
  const qaDirectory = NodePath.join(paths.qa, manifest.release, scene.id);
  FileSystem.mkdirSync(outputDirectory, { recursive: true });
  FileSystem.mkdirSync(posterDirectory, { recursive: true });

  const targets = [
    {
      suffix: "",
      width: manifest.delivery.desktopWidth,
      height: manifest.geometry.masterHeight,
    },
    {
      suffix: "-mobile",
      width: manifest.delivery.mobileWidth,
      height: Math.round(
        (manifest.delivery.mobileWidth * manifest.geometry.masterHeight) /
          manifest.geometry.masterWidth,
      ),
    },
  ];
  for (const target of targets) {
    encodeVideo({
      sourcePath,
      outputPath: NodePath.join(outputDirectory, `${scene.id}${target.suffix}.mp4`),
      width: target.width,
      height: target.height,
      codec: "h264",
      framesPerSecond: manifest.geometry.framesPerSecond,
      keyframeSeconds: manifest.delivery.keyframeIntervalSeconds,
    });
    encodeVideo({
      sourcePath,
      outputPath: NodePath.join(outputDirectory, `${scene.id}${target.suffix}.webm`),
      width: target.width,
      height: target.height,
      codec: "vp9",
      framesPerSecond: manifest.geometry.framesPerSecond,
      keyframeSeconds: manifest.delivery.keyframeIntervalSeconds,
    });
  }

  const posterPng = NodePath.join(posterDirectory, `${scene.id}.png`);
  run("ffmpeg", [
    "-y",
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${manifest.geometry.masterWidth}:${manifest.geometry.masterHeight}:flags=lanczos`,
    posterPng,
  ]);
  const posterWebp = NodePath.join(outputDirectory, `${scene.id}-poster.webp`);
  if (commandExists("magick")) {
    run("magick", [posterPng, "-quality", String(manifest.delivery.posterQuality), posterWebp]);
  } else {
    run("ffmpeg", [
      "-y",
      "-i",
      posterPng,
      "-quality",
      String(manifest.delivery.posterQuality),
      posterWebp,
    ]);
  }
  extractQaFrames({
    sourcePath,
    sceneId: scene.id,
    duration: master.duration,
    qaDirectory,
  });
  await postflight({ manifest, scene, outputDirectory, qaDirectory });
  console.log(`Exported ${scene.id}: ${outputDirectory}`);
}

function hasFastStart(filePath: string): boolean {
  const buffer = FileSystem.readFileSync(filePath);
  const moov = buffer.indexOf(Buffer.from("moov"));
  const mdat = buffer.indexOf(Buffer.from("mdat"));
  return moov !== -1 && mdat !== -1 && moov < mdat;
}

function extractOcrText(framePaths: ReadonlyArray<string>): string | null {
  if (process.platform === "darwin" && commandExists("swift")) {
    return run("swift", [
      NodePath.join(REPO_ROOT, "scripts", "fixtures", "marketing-studio", "ocr-frames.swift"),
      ...framePaths,
    ]);
  }
  if (commandExists("tesseract")) {
    return framePaths
      .map((framePath) => {
        const text = run("tesseract", [framePath, "stdout", "--psm", "11"]);
        return `${NodePath.basename(framePath)}\t${text}`;
      })
      .join("\n");
  }
  return null;
}

function assertOcrIsPublishSafe(text: string): void {
  const riskyPatterns = [
    { label: "personal macOS path", pattern: /\/Users\/(?!Shared(?:\/|$))[^/\s]+/i },
    { label: "personal Windows path", pattern: /[A-Z]:\\Users\\(?!Public(?:\\|$))[^\\\s]+/i },
    { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
    { label: "API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  ];
  for (const risk of riskyPatterns) {
    if (risk.pattern.test(text)) {
      throw new Error(`OCR safety scan found a possible ${risk.label}. Review QA frames.`);
    }
  }

  const emails = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
  const unsafeEmail = emails.find((email) => !email.toLowerCase().endsWith(".example"));
  if (unsafeEmail) {
    throw new Error("OCR safety scan found a non-example email address. Review QA frames.");
  }
}

async function postflight(supplied?: {
  readonly manifest: CaptureManifest;
  readonly scene: CaptureScene;
  readonly outputDirectory: string;
  readonly qaDirectory: string;
}): Promise<void> {
  const manifest = supplied?.manifest ?? readManifest();
  const scene = supplied?.scene ?? resolveScene(manifest);
  const paths = studioPaths();
  const outputDirectory = NodePath.resolve(
    argument("output-dir") ??
      supplied?.outputDirectory ??
      NodePath.join(paths.exports, manifest.release, scene.id),
  );
  const qaDirectory = supplied?.qaDirectory ?? NodePath.join(paths.qa, manifest.release, scene.id);
  const expected = [
    {
      name: `${scene.id}.mp4`,
      codec: "h264",
      width: manifest.delivery.desktopWidth,
      height: manifest.geometry.masterHeight,
    },
    {
      name: `${scene.id}.webm`,
      codec: "vp9",
      width: manifest.delivery.desktopWidth,
      height: manifest.geometry.masterHeight,
    },
    {
      name: `${scene.id}-mobile.mp4`,
      codec: "h264",
      width: manifest.delivery.mobileWidth,
      height: Math.round(
        (manifest.delivery.mobileWidth * manifest.geometry.masterHeight) /
          manifest.geometry.masterWidth,
      ),
    },
    {
      name: `${scene.id}-mobile.webm`,
      codec: "vp9",
      width: manifest.delivery.mobileWidth,
      height: Math.round(
        (manifest.delivery.mobileWidth * manifest.geometry.masterHeight) /
          manifest.geometry.masterWidth,
      ),
    },
  ];

  const files = expected.map((item) => {
    const filePath = NodePath.join(outputDirectory, item.name);
    if (!FileSystem.existsSync(filePath)) {
      throw new Error(`Missing delivery export: ${filePath}`);
    }
    const result = probe(filePath);
    const stream = videoStream(result);
    if (
      stream.codec_name !== item.codec ||
      stream.width !== item.width ||
      stream.height !== item.height
    ) {
      throw new Error(
        `${item.name} has ${String(stream.codec_name)} ${String(stream.width)}×${String(stream.height)}; expected ${item.codec} ${item.width}×${item.height}.`,
      );
    }
    const fps = frameRate(stream.avg_frame_rate);
    if (Math.abs(fps - manifest.geometry.framesPerSecond) > 0.02) {
      throw new Error(`${item.name} is ${fps.toFixed(3)} fps instead of true 60 fps.`);
    }
    if (result.streams.some((candidate) => candidate.codec_type === "audio")) {
      throw new Error(`${item.name} unexpectedly contains audio.`);
    }
    if (stream.pix_fmt !== "yuv420p") {
      throw new Error(`${item.name} uses ${String(stream.pix_fmt)} instead of yuv420p.`);
    }
    if (
      stream.color_primaries !== "bt709" ||
      stream.color_transfer !== "bt709" ||
      stream.color_space !== "bt709"
    ) {
      throw new Error(`${item.name} is missing explicit BT.709 color tags.`);
    }
    if (item.codec === "h264" && !hasFastStart(filePath)) {
      throw new Error(`${item.name} is not fast-start optimized.`);
    }
    return {
      ...item,
      path: filePath,
      fps,
      pixelFormat: stream.pix_fmt,
      sha256: sha256(filePath),
      sizeBytes: FileSystem.statSync(filePath).size,
    };
  });

  const qaFrames = ["first", "middle", "last", "contact-sheet"].map((suffix) =>
    NodePath.join(qaDirectory, `${scene.id}-${suffix}.png`),
  );
  for (const qaFrame of qaFrames) {
    if (!FileSystem.existsSync(qaFrame)) {
      throw new Error(`Missing QA frame: ${qaFrame}`);
    }
  }
  const ocrText = extractOcrText(qaFrames);
  if (ocrText !== null) {
    assertOcrIsPublishSafe(ocrText);
    FileSystem.writeFileSync(
      NodePath.join(qaDirectory, `${scene.id}-ocr.txt`),
      ocrText.endsWith("\n") ? ocrText : `${ocrText}\n`,
    );
  } else {
    console.warn("OCR is unavailable on this platform; perform the frame safety review manually.");
  }

  const reportPath = NodePath.join(qaDirectory, `${scene.id}-postflight.json`);
  FileSystem.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        sceneId: scene.id,
        release: manifest.release,
        checkedAt: new Date().toISOString(),
        files,
        qaFrames,
        ocrSafetyScan: ocrText === null ? "unavailable" : "passed",
        manualChecks: [
          "Review every QA frame and the contact sheet at full size.",
          "Confirm the first and last frames support the intended playback behavior.",
          "Confirm no notification, account, personal path, or recorder overlay is visible.",
        ],
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Postflight passed for ${scene.id}: ${reportPath}`);
}

function printHelp(): void {
  console.log(
    [
      "Threadlines marketing capture tools",
      "",
      "Commands:",
      "  prepare   --scene <id>                    Set deterministic theme and scene marker",
      "  preflight --scene <id>                    Verify studio, safety, geometry, and visible state",
      "  still     --scene <id>                    Capture a clean 2× renderer still",
      "  record    --scene <id>                    Record an automated macOS window take",
      "  export    --scene <id> [--input <master>] Create desktop/mobile WebM, MP4, and posters",
      "  postflight --scene <id> [--output-dir <dir>] Verify delivery files and QA frames",
      "",
      "Useful flags:",
      "  --allow-personal-path      Allow a reviewed studio path under the home directory",
      "  --allow-compressed-master  Allow a reviewed H.264 4:2:0 source master",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "prepare":
      await prepare();
      return;
    case "preflight":
      await preflight();
      return;
    case "still":
      await still();
      return;
    case "record":
      await record();
      return;
    case "export":
      await exportMedia();
      return;
    case "postflight":
      await postflight();
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown marketing media command: ${String(process.argv[2])}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
