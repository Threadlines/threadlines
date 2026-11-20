import type { DevicePlatform } from "@threadlines/contracts";
import type { DeviceStreamClient } from "@threadlines/client-runtime/device";

import type { DeviceInput } from "./deviceRecording.logic";

/**
 * The stream client, telling `onInput` about each input it forwards, as a
 * recording names it. The client itself is unchanged: this only listens.
 * Android sends Escape as Back, so it is heard as the Back button.
 */
export function observeDeviceStreamInput(
  client: DeviceStreamClient,
  platform: DevicePlatform,
  onInput: (input: DeviceInput) => void,
): DeviceStreamClient {
  const ios = platform === "ios";
  return {
    ...client,
    sendTouch: (phase, x, y) => {
      onInput({ type: "touch", phase, x, y });
      client.sendTouch(phase, x, y);
    },
    // iPhone Duo touches go to the display's own framebuffer, which is also
    // what its accessibility tree measures, so they are heard the same way.
    sendRawTouch: (phase, x, y) => {
      onInput({ type: "touch", phase, x, y });
      client.sendRawTouch(phase, x, y);
    },
    sendKey: (event, phase) => {
      if (phase === "down") {
        onInput(
          !ios && event.key === "Escape"
            ? { type: "button", button: "back" }
            : {
                type: "key",
                key: event.key,
                ctrl: event.ctrlKey,
                alt: event.altKey,
                meta: event.metaKey,
              },
        );
      }
      client.sendKey(event, phase);
    },
    sendText: (text) => {
      onInput({ type: "text", text });
      client.sendText(text);
    },
    pressButton: (button) => {
      // iOS has no Back; the client drops it.
      if (!(ios && button === "back")) onInput({ type: "button", button });
      client.pressButton(button);
    },
    rotate: () => {
      // Android rotates through the Tools drawer, heard as that action.
      if (ios) onInput({ type: "rotate" });
      client.rotate();
    },
  };
}
