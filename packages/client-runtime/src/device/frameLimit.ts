/**
 * The most one video frame or one hub message may hold in this client. A
 * simulator's largest keyframe is a few megabytes; anything past this is a
 * broken or hostile stream (a compromised saved computer can send any bytes),
 * so the parsers stop instead of buffering it and the viewer reconnects.
 */
export const DEVICE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class DeviceFrameTooLargeError extends Error {
  constructor(what: string, bytes: number) {
    super(
      `The device sent a ${what} of ${bytes} bytes, more than the ${DEVICE_MAX_FRAME_BYTES} this viewer accepts. Reconnecting…`,
    );
    this.name = "DeviceFrameTooLargeError";
  }
}
