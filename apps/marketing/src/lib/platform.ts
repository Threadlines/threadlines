export type Device = "mac" | "windows" | "linux" | "mobile" | "unknown";

export type MacArch = "arm64" | "x64";

interface UserAgentData {
  readonly platform?: string;
  getHighEntropyValues?(hints: ReadonlyArray<string>): Promise<{ architecture?: string }>;
}

// The parts of `navigator` the detection reads. `userAgentData` is Chromium-only
// and missing from TypeScript's DOM types.
export interface NavigatorLike {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
  readonly userAgentData?: UserAgentData;
}

// True when touch is the only way in (no hover, coarse pointer): a phone, or a
// tablet with no mouse attached. A touchscreen laptop still has its trackpad.
export function isTouchOnly(win: Pick<Window, "matchMedia">): boolean {
  return win.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

// What the visitor is browsing on. "mobile" covers phones and tablets, which
// can't install Threadlines; "unknown" is a desktop we have no installer label for.
export function detectDevice(nav: NavigatorLike, touchOnly = false): Device {
  const userAgent = nav.userAgent.toLowerCase();
  const platform = (nav.userAgentData?.platform ?? "").toLowerCase();
  const isLinux = platform.includes("linux") || userAgent.includes("linux");
  // iPad Safari sends a Mac user agent; only the touchscreen gives it away.
  const isIpad = userAgent.includes("macintosh") && (nav.maxTouchPoints ?? 0) > 1;
  // Android's "desktop site" mode, the default on large tablets, claims to be a Linux PC.
  const isAndroidDesktopMode = isLinux && touchOnly;
  if (
    isIpad ||
    isAndroidDesktopMode ||
    platform.includes("android") ||
    /android|iphone|ipad|ipod/.test(userAgent)
  ) {
    return "mobile";
  }
  if (platform.includes("win") || userAgent.includes("windows")) return "windows";
  if (platform.includes("mac") || userAgent.includes("macintosh")) return "mac";
  if (isLinux) return "linux";
  return "unknown";
}

// How long a browser gets to answer before the page stops waiting on it.
const MAC_ARCH_TIMEOUT_MS = 1000;

// Which chip a Mac has. Every Mac browser's user agent says "Intel", so the
// only honest source is Chromium's client hints. Safari and Firefox resolve
// undefined, and the visitor picks an installer themselves. Never rejects.
export async function detectMacArch(nav: NavigatorLike): Promise<MacArch | undefined> {
  const data = nav.userAgentData;
  if (!data?.getHighEntropyValues) return undefined;
  try {
    const hints = await Promise.race([
      data.getHighEntropyValues(["architecture"]),
      new Promise<undefined>((resolve) => setTimeout(resolve, MAC_ARCH_TIMEOUT_MS)),
    ]);
    if (hints?.architecture === "arm") return "arm64";
    if (hints?.architecture === "x86") return "x64";
  } catch {
    // The browser declined to share it.
  }
  return undefined;
}
