import { RELAY_TOKEN_PROTOCOL_PREFIX, RELAY_WEBSOCKET_PROTOCOL } from "@threadlines/contracts";

const OPEN_TIMEOUT_MS = 10_000;

function waitForOpen(socket: WebSocket, label: string): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} socket did not open in time.`));
    }, OPEN_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`${label} socket failed to open.`));
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`${label} socket closed before opening (${event.code}).`));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function closeQuietly(socket: WebSocket, reason: string): void {
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.close(1000, reason.slice(0, 120));
  } catch {
    // Already closing.
  }
}

/** The host end of a device's relay pipe, binary frames as ArrayBuffers. */
export async function openRelayPipeSocket(input: {
  readonly relayPipeUrl: string;
  readonly hostSecret: string;
}): Promise<WebSocket> {
  const socket = new WebSocket(input.relayPipeUrl, [
    RELAY_WEBSOCKET_PROTOCOL,
    `${RELAY_TOKEN_PROTOCOL_PREFIX}${input.hostSecret}`,
  ]);
  socket.binaryType = "arraybuffer";
  try {
    await waitForOpen(socket, "Relay pipe");
  } catch (error) {
    closeQuietly(socket, "Relay pipe failed.");
    throw error;
  }
  return socket;
}

/** This server's own `/ws`, signed in as a device's session. */
export async function openLoopbackSocket(localSocketUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(localSocketUrl);
  try {
    await waitForOpen(socket, "Local server");
  } catch (error) {
    closeQuietly(socket, "Connection aborted.");
    throw error;
  }
  return socket;
}
