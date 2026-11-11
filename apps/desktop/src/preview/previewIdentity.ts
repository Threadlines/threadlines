/**
 * The browser the in-app browser says it is: Google Chrome, at the version of
 * Chromium it is built on.
 *
 * A browser names itself twice. The user agent string is the old way; the
 * "client hints" brand list (`navigator.userAgentData`, the `sec-ch-ua`
 * headers) is the new one, and sign-in bot checks compare the two. Left alone,
 * an Electron guest says `Electron/x` in the first and only "Chromium" in the
 * second, which is what automation tools send, so real sites turned real
 * people away: GoDaddy refused a hand-typed sign-in, and went on refusing it
 * under every user agent string, Chrome's own included, until the brand list
 * said Chrome as well. A half claim is the worst of the lot: Chrome's string
 * over a Chromium brand list is what failed Cloudflare's check in October
 * 2026. So the claim is made whole or not at all:
 *
 * - The string is set on the browser's session (`PreviewSession`), which
 *   reaches every request and every page.
 * - The brand list has no Electron setting. It is set through the DevTools
 *   protocol, on each page and on each frame and worker inside it, which is
 *   why a page gets a debugger as soon as it is attached to its tab or made
 *   for its pop-up, ahead of its first page's scripts.
 *
 * What remains, all of it narrow:
 * - While DevTools is open on a page it holds the debugger, so that page
 *   shows Chrome's string over the Chromium list until the panel next acts
 *   on it.
 * - Service workers and shared workers are left as Electron made them, with
 *   Electron's string and the Chromium list in `navigator`: a string only an
 *   app-wide setting changes, and a debugger on a service worker would keep
 *   it from ever going idle. Their requests still carry Chrome's string.
 * - Chrome sends its brand list with a page's own request too. Electron sends
 *   it only with the requests a page makes, whatever the list says.
 */
import type * as Electron from "electron";

export interface BrowserIdentity {
  readonly userAgent: string;
  /** `Emulation.setUserAgentOverride`'s `userAgentMetadata`. */
  readonly userAgentMetadata: {
    readonly brands: ReadonlyArray<{ readonly brand: string; readonly version: string }>;
    readonly fullVersionList: ReadonlyArray<{ readonly brand: string; readonly version: string }>;
    readonly fullVersion: string;
    readonly platform: string;
    readonly platformVersion: string;
    readonly architecture: string;
    readonly bitness: string;
    readonly model: string;
    readonly mobile: boolean;
    readonly wow64: boolean;
    readonly formFactors: ReadonlyArray<string>;
  };
}

export interface BrowserIdentityInput {
  /** Electron's own user agent, for the platform part Chromium wrote. */
  readonly defaultUserAgent: string;
  /** `process.versions.chrome`. */
  readonly chromeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** `process.getSystemVersion()`. */
  readonly systemVersion: string;
}

const GREASE_CHARACTERS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

/**
 * Chrome's brand list for a major version, as Chromium builds it: a made-up
 * brand that changes with the version (so sites cannot hard-code the list),
 * "Chromium" and "Google Chrome", in an order that also follows the version.
 * `fullVersions` gives each brand its whole version rather than the major one.
 */
function chromeBrands(chromeVersion: string, fullVersions: boolean) {
  const major = Number.parseInt(chromeVersion, 10);
  const seed = Number.isFinite(major) ? major : 0;
  const greaseVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.length] ?? "8";
  const version = fullVersions ? chromeVersion : String(seed);
  const entries = [
    {
      brand: `Not${GREASE_CHARACTERS[seed % GREASE_CHARACTERS.length]}A${
        GREASE_CHARACTERS[(seed + 1) % GREASE_CHARACTERS.length]
      }Brand`,
      version: fullVersions ? `${greaseVersion}.0.0.0` : greaseVersion,
    },
    { brand: "Chromium", version },
    { brand: "Google Chrome", version },
  ];
  const order = BRAND_ORDERS[seed % BRAND_ORDERS.length] ?? BRAND_ORDERS[0];
  const placed = [...entries];
  entries.forEach((entry, index) => {
    placed[order[index] ?? index] = entry;
  });
  return placed;
}

/**
 * The platform version Chrome reports. macOS gives its own version and Linux
 * its kernel's. Windows gives the version of an API contract rather than of
 * Windows, which follows the build: 19 from Windows 11 24H2, 15 from 22H2,
 * 14 for the first Windows 11, 10 for Windows 10 since 2004.
 */
function chromePlatformVersion(platform: NodeJS.Platform, systemVersion: string): string {
  const numbers = (systemVersion.match(/\d+/g) ?? []).map(Number);
  if (platform === "win32") {
    const build = numbers[2] ?? 0;
    const contract =
      build >= 26100 ? 19 : build >= 22621 ? 15 : build >= 22000 ? 14 : build >= 19041 ? 10 : 8;
    return `${contract}.0.0`;
  }
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0].join(".");
}

/** What Chrome would say about itself on this computer, at Electron's Chromium version. */
export function chromeIdentity(input: BrowserIdentityInput): BrowserIdentity {
  const major = Number.parseInt(input.chromeVersion, 10);
  // Chromium wrote the platform part, already frozen the way Chrome freezes
  // it. Everything after it is rebuilt, so no app or Electron token survives
  // whatever the app is called, and the version is the short one Chrome sends.
  const platformPart =
    /^Mozilla\/5\.0 \(([^)]*)\)/.exec(input.defaultUserAgent)?.[1] ?? "X11; Linux x86_64";
  return {
    userAgent: `Mozilla/5.0 (${platformPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
      Number.isFinite(major) ? major : 0
    }.0.0.0 Safari/537.36`,
    userAgentMetadata: {
      brands: chromeBrands(input.chromeVersion, false),
      fullVersionList: chromeBrands(input.chromeVersion, true),
      // These two a page keeps without being told, but a worker told the rest
      // reads them back empty unless they are given.
      fullVersion: input.chromeVersion,
      formFactors: ["Desktop"],
      platform:
        input.platform === "darwin" ? "macOS" : input.platform === "win32" ? "Windows" : "Linux",
      platformVersion: chromePlatformVersion(input.platform, input.systemVersion),
      architecture: input.arch.startsWith("arm") ? "arm" : "x86",
      bitness: input.arch === "ia32" || input.arch === "arm" ? "32" : "64",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
}

let current: BrowserIdentity | undefined;

/** This app's identity for its browser pages; the same for as long as it runs. */
export function browserIdentity(app: Electron.App): BrowserIdentity {
  current ??= chromeIdentity({
    defaultUserAgent: app.userAgentFallback,
    chromeVersion: process.versions.chrome ?? "",
    platform: process.platform,
    arch: process.arch,
    systemVersion: process.getSystemVersion(),
  });
  return current;
}

/**
 * Which targets inside a page get a session of their own: frames in another
 * process (the agent's input and snapshots need those too) and its workers.
 * They are not held at their start for it: the page's own override already
 * covers what they read first, and a frame held for an answer that never
 * came would never load.
 */
export const CHILD_TARGET_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "iframe" }, { type: "worker" }],
};

/** `Emulation.setUserAgentOverride`'s parameters, for callers with their own way to send. */
export function identityOverride(identity: BrowserIdentity): Record<string, unknown> {
  return { userAgent: identity.userAgent, userAgentMetadata: identity.userAgentMetadata };
}

/**
 * Names the browser in one debugger session: the page's own when `sessionId`
 * is absent, a frame's or worker's otherwise. Resolves either way; a target
 * that went away before it heard has no one left to tell.
 */
function presentIdentityTo(
  target: Electron.Debugger,
  identity: BrowserIdentity,
  sessionId?: string,
): Promise<void> {
  return target
    .sendCommand("Emulation.setUserAgentOverride", identityOverride(identity), sessionId)
    .then(
      () => {},
      () => {},
    );
}

/**
 * Names the browser in a frame or worker that just got its session, and has
 * the targets inside it report in the same way.
 */
export function presentIdentityToChild(
  target: Electron.Debugger,
  identity: BrowserIdentity,
  sessionId: string,
): void {
  void presentIdentityTo(target, identity, sessionId);
  target.sendCommand("Target.setAutoAttach", CHILD_TARGET_AUTO_ATTACH, sessionId).catch(() => {});
}

/**
 * Names the browser in a page nothing else holds a debugger on: a sign-in
 * pop-up, which the agent never drives. Call it before the page first loads.
 * Panel tabs get the same from `PreviewAutomation.attach`, which also needs
 * the frames' sessions for itself.
 */
export function presentIdentityInWindow(
  contents: Electron.WebContents,
  identity: BrowserIdentity,
): void {
  const target = contents.debugger;
  try {
    if (!target.isAttached()) target.attach("1.3");
  } catch {
    // Something else holds the debugger. The page keeps the session's string
    // over the Chromium list, as a page with DevTools open does.
    return;
  }
  target.on("message", (_event, method, params: { sessionId?: unknown }) => {
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      presentIdentityToChild(target, identity, params.sessionId);
    }
  });
  void presentIdentityTo(target, identity);
  target.sendCommand("Target.setAutoAttach", CHILD_TARGET_AUTO_ATTACH).catch(() => {});
}
