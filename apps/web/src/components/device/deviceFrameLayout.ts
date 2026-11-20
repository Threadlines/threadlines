import type { DevicePlatform } from "@threadlines/contracts";
import type { DeviceScreenSize } from "@threadlines/client-runtime/device";

/** The largest box of `aspect` (width / height) that fits `width` × `height`. */
export function fitDeviceFrame(aspect: number, width: number, height: number) {
  if (width <= 0 || height <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { width: 0, height: 0 };
  }
  const byHeight = { width: height * aspect, height };
  return byHeight.width <= width ? byHeight : { width, height: width / aspect };
}

/** The screen's width / height as shown, before the first frame a phone's usual shape. */
export function deviceScreenAspect(platform: DevicePlatform, screen: DeviceScreenSize | null) {
  if (!screen) return platform === "ios" ? 9 / 19.5 : 9 / 20;
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return landscape ? long / short : short / long;
}

/** serve-sim sends portrait framebuffers even when iOS is landscape; the view turns them. */
export function deviceScreenRotation(platform: DevicePlatform, screen: DeviceScreenSize | null) {
  if (platform !== "ios" || !screen || screen.width > screen.height) return 0;
  switch (screen.orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return -90;
    case "portrait_upside_down":
      return 180;
    default:
      return 0;
  }
}
