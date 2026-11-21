import type { DevicePlatform, DeviceSummary } from "@threadlines/contracts";

/**
 * The hardware outlines the Device tab draws around a live screen
 * (docs/design/devices.md, "Round 2"). All lengths are in points of the
 * device's own screen, upright. Screen sizes and corner radii come from each
 * simulator's display description in Xcode (`capabilities.plist`), bezels and
 * button positions from its device chrome description; nothing of Apple's
 * artwork is used. Frames are picked by `DeviceSummary.model`, never by name.
 */

export interface DeviceButton {
  readonly edge: "left" | "right" | "top";
  /** From the body's top (left and right edges) or left (top edge) to the button's start. */
  readonly offset: number;
  readonly length: number;
}

/** What the hardware puts over the top of the screen. */
export type DeviceCutout =
  | {
      readonly kind: "island";
      readonly width: number;
      readonly height: number;
      readonly top: number;
    }
  | { readonly kind: "notch"; readonly width: number; readonly height: number }
  | {
      readonly kind: "punch";
      readonly diameter: number;
      readonly top: number;
      /** The hole's center from the screen's left edge; centered when left out. */
      readonly centerX?: number;
    };

export interface DeviceBody {
  /** The screen, upright. The simulator's reported aspect replaces `height` when it differs. */
  readonly screen: { readonly width: number; readonly height: number };
  /** Screen corner radii, clockwise from top left (a Duo's cover is square on its hinge side). */
  readonly screenRadius: readonly [number, number, number, number];
  /** Glass and band from the screen's edge to the body's, per side. */
  readonly bezel: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  readonly buttons: ReadonlyArray<DeviceButton>;
  readonly cutout: DeviceCutout | null;
  /** A round home button under the screen (iPhone SE), its diameter. */
  readonly homeButton?: number;
  /** A fold line across an unfolded screen. */
  readonly crease?: "vertical";
}

export type DeviceShape =
  | { readonly kind: "single"; readonly body: DeviceBody }
  /** iPhone Duo: the cover (display 1) and the inner screen (display 3), shown open and wide. */
  | { readonly kind: "duo"; readonly cover: DeviceBody; readonly inner: DeviceBody };

const radius = (value: number) => [value, value, value, value] as const;
const even = (value: number) => ({ top: value, right: value, bottom: value, left: value });

// The Dynamic Island as the simulator draws it into its own framebuffer
// (measured from serve-sim's screenshots), so the drawn one sits exactly on it.
const ISLAND: DeviceCutout = { kind: "island", width: 95, height: 37, top: 14 };

// iPhone 17 and 18 Pro (Xcode chrome "phone11"): 402 × 874 pt, radius 62.
const PHONE_6_3: DeviceBody = {
  screen: { width: 402, height: 874 },
  screenRadius: radius(62),
  bezel: even(17),
  buttons: [
    { edge: "left", offset: 160, length: 34 },
    { edge: "left", offset: 221, length: 64 },
    { edge: "left", offset: 300, length: 64 },
    { edge: "right", offset: 262, length: 101 },
  ],
  cutout: ISLAND,
};

// iPhone 18 Pro Max ("phone12"): 440 × 956 pt.
const PHONE_6_9: DeviceBody = {
  screen: { width: 440, height: 956 },
  screenRadius: radius(62),
  bezel: even(17),
  buttons: [
    { edge: "left", offset: 180, length: 34 },
    { edge: "left", offset: 268, length: 64 },
    { edge: "left", offset: 354, length: 64 },
    { edge: "right", offset: 293, length: 101 },
  ],
  cutout: ISLAND,
};

// iPhone Air ("phone12", thinner band): 420 × 912 pt.
const PHONE_AIR: DeviceBody = {
  screen: { width: 420, height: 912 },
  screenRadius: radius(62),
  bezel: even(15),
  buttons: [
    { edge: "left", offset: 172, length: 34 },
    { edge: "left", offset: 256, length: 62 },
    { edge: "left", offset: 338, length: 62 },
    { edge: "right", offset: 280, length: 98 },
  ],
  cutout: { kind: "island", width: 125, height: 37, top: 20 },
};

// iPhone 17e ("phone13"): 390 × 844 pt, radius 47.33, notch.
const PHONE_E: DeviceBody = {
  screen: { width: 390, height: 844 },
  screenRadius: radius(47.33),
  bezel: even(19),
  buttons: [
    { edge: "left", offset: 160, length: 32 },
    { edge: "left", offset: 221, length: 72 },
    { edge: "left", offset: 300, length: 72 },
    { edge: "right", offset: 262, length: 117 },
  ],
  cutout: { kind: "notch", width: 162, height: 33 },
};

// iPhone SE ("phone"): 375 × 667 pt, square screen, home button.
const PHONE_SE: DeviceBody = {
  screen: { width: 375, height: 667 },
  screenRadius: radius(0),
  bezel: { top: 111, right: 28, bottom: 111, left: 28 },
  buttons: [
    { edge: "left", offset: 114, length: 36 },
    { edge: "left", offset: 188, length: 68 },
    { edge: "left", offset: 269, length: 68 },
    { edge: "right", offset: 188, length: 68 },
  ],
  cutout: null,
  homeButton: 67,
};

// iPhone Duo. The cover ("phone15", display 1) is 466 × 678 pt, square on its
// hinge side (left); the inner screen ("phone14", display 3) is 669 × 951 pt
// mounted a quarter turn, so open it is 951 × 669 with the hinge down the middle.
const DUO_COVER: DeviceBody = {
  screen: { width: 466, height: 678 },
  screenRadius: [8, 59, 59, 8],
  bezel: { top: 14, right: 22, bottom: 14, left: 26 },
  buttons: [
    { edge: "top", offset: 236, length: 66 },
    { edge: "top", offset: 316, length: 66 },
    { edge: "right", offset: 202, length: 113 },
  ],
  // A round camera hole near the top right, as the simulator draws it into the
  // cover's framebuffer (measured on iOS 27.2 24B91016s: 111 px across, centered
  // at 1254 × 143 px of 1398 × 2034, at 3x), not the iPhones' island.
  cutout: { kind: "punch", diameter: 37, top: 29.2, centerX: 418 },
};
const DUO_INNER: DeviceBody = {
  screen: { width: 951, height: 669 },
  screenRadius: radius(55),
  bezel: even(17),
  // The cover's buttons, seen from the front of the open phone: on the right half.
  buttons: [
    { edge: "top", offset: 735, length: 66 },
    { edge: "top", offset: 815, length: 66 },
  ],
  cutout: null,
  crease: "vertical",
};

// iPad Pro 11 and 13-inch (M5) ("tablet5"): radius 30.
const tabletPro = (width: number, height: number): DeviceBody => ({
  screen: { width, height },
  screenRadius: radius(30),
  bezel: even(46),
  buttons: [
    { edge: "right", offset: 100, length: 52 },
    { edge: "right", offset: 163, length: 52 },
    { edge: "top", offset: width + 92 - 74 - 63, length: 63 },
  ],
  cutout: null,
});

// iPad Air (M4) and iPad (A16) ("tablet4").
const tabletAir = (width: number, height: number, screenRadius: number): DeviceBody => ({
  screen: { width, height },
  screenRadius: radius(screenRadius),
  bezel: even(59),
  buttons: [
    { edge: "right", offset: 120, length: 52 },
    { edge: "right", offset: 182, length: 52 },
    { edge: "top", offset: width + 118 - 84 - 89, length: 89 },
  ],
  cutout: null,
});

// iPad mini ("tablet3"/"tablet6"): 744 × 1133 pt, radius 21.5.
const TABLET_MINI: DeviceBody = {
  screen: { width: 744, height: 1133 },
  screenRadius: radius(21.5),
  bezel: even(60),
  buttons: [
    { edge: "top", offset: 82, length: 65 },
    { edge: "top", offset: 158, length: 65 },
    { edge: "top", offset: 744 + 120 - 82 - 111, length: 111 },
  ],
  cutout: null,
};

// A generic Android phone and foldable: thin even bezels, a punch-hole camera, side keys on the right.
const ANDROID_PHONE: DeviceBody = {
  screen: { width: 412, height: 915 },
  screenRadius: radius(36),
  bezel: even(11),
  buttons: [
    { edge: "right", offset: 190, length: 96 },
    { edge: "right", offset: 330, length: 62 },
  ],
  cutout: { kind: "punch", diameter: 18, top: 14 },
};
/** Unfolded, wide, with the fold down the middle (see `crease`). */
const ANDROID_FOLDABLE: DeviceBody = {
  ...ANDROID_PHONE,
  crease: "vertical",
  screen: { width: 841, height: 701 },
  screenRadius: radius(24),
  buttons: [
    { edge: "right", offset: 150, length: 70 },
    { edge: "right", offset: 260, length: 54 },
  ],
  cutout: null,
};
const ANDROID_TABLET: DeviceBody = {
  screen: { width: 800, height: 1280 },
  screenRadius: radius(20),
  bezel: even(36),
  buttons: [
    { edge: "top", offset: 120, length: 90 },
    { edge: "right", offset: 140, length: 70 },
  ],
  cutout: null,
};

const SIM = "com.apple.CoreSimulator.SimDeviceType.";

/** iOS device types by their simulator id after `SimDeviceType.`, memory suffixes removed. */
const IOS_SHAPES: ReadonlyArray<readonly [RegExp, DeviceShape]> = [
  [/^iPhone-Duo$/, { kind: "duo", cover: DUO_COVER, inner: DUO_INNER }],
  [/^iPhone-1[78]-Pro-Max$/, { kind: "single", body: PHONE_6_9 }],
  [/^iPhone-1[78](-Pro)?$/, { kind: "single", body: PHONE_6_3 }],
  [/^iPhone-Air$/, { kind: "single", body: PHONE_AIR }],
  [/^iPhone-1[67]e$/, { kind: "single", body: PHONE_E }],
  [/^iPhone-SE/, { kind: "single", body: PHONE_SE }],
  [/^iPad-Pro-11-inch-M5/, { kind: "single", body: tabletPro(834, 1210) }],
  [/^iPad-Pro-13-inch-M5/, { kind: "single", body: tabletPro(1032, 1376) }],
  [/^iPad-Air-11-inch-M4$/, { kind: "single", body: tabletAir(820, 1180, 18) }],
  [/^iPad-Air-13-inch-M4$/, { kind: "single", body: tabletAir(1024, 1366, 18) }],
  [/^iPad-A16$/, { kind: "single", body: tabletAir(820, 1180, 25) }],
  [/^iPad-mini-A(17|20)-Pro$/, { kind: "single", body: TABLET_MINI }],
];

/**
 * The outline for a device, or null for the plain rounded frame (an unknown
 * model, an older server that sends none, a physical phone).
 *
 * Android has no reliable model list, so an emulator with a hardware profile
 * gets the generic phone, or the tablet when the screen is near square; one
 * without a profile keeps the plain frame. A foldable (its
 * profile says so, `pixel_fold`, or the emulator reports a hinge) is the
 * phone while folded and the wide unfolded body once its screen is: the
 * frame follows the posture through the screen's own shape.
 */
export function deviceShape(
  device: Pick<DeviceSummary, "platform" | "model" | "physical">,
  options: {
    readonly foldable?: boolean;
    /** Short side over long side of the screen now, when known. */
    readonly portraitAspect?: number;
  } = {},
): DeviceShape | null {
  if (device.platform === "ios") {
    const type = device.model?.startsWith(SIM) ? device.model.slice(SIM.length) : null;
    if (!type) return null;
    const bare = type.replace(/-(8|12|16)GB$/, "");
    return IOS_SHAPES.find(([pattern]) => pattern.test(bare))?.[1] ?? null;
  }
  if (device.physical) return null;
  const foldable = options.foldable === true || /fold/i.test(device.model ?? "");
  // No hardware profile (an older server, or an AVD made without one): the plain frame,
  // unless the emulator itself says it folds.
  if (!device.model && !foldable) return null;
  const wide = (options.portraitAspect ?? 0) > 0.66;
  if (foldable) return { kind: "single", body: wide ? ANDROID_FOLDABLE : ANDROID_PHONE };
  if (wide || /tablet/i.test(device.model ?? "")) return { kind: "single", body: ANDROID_TABLET };
  return { kind: "single", body: ANDROID_PHONE };
}

/** The phone's usual screen shape before the first frame tells the real one. */
export const defaultPortraitAspect = (platform: DevicePlatform) =>
  platform === "ios" ? 9 / 19.5 : 9 / 20;
