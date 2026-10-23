/**
 * "Connect to a computer": anything in the app opens it through
 * openConnectComputerDialog, and the host mounted once with the app shell
 * shows it. Its body is a chunk of its own (JoinComputerDialogContent.tsx),
 * loaded the first time it opens.
 */
import { Suspense } from "react";
import { create } from "zustand";

import { RelayJoinError } from "~/environments/runtime";
import { lazyWithPreload } from "~/lib/lazyWithPreload";
import { RelayRequestError } from "~/relayDevice";

const JoinComputerDialog = lazyWithPreload(() =>
  import("./JoinComputerDialogContent").then((module) => module.JoinComputerDialog),
);

/** Fetches the dialog's body ahead of its first open. */
export const preloadConnectComputerDialog = JoinComputerDialog.preload;

/** What the joiner sees for each relay error code. */
export function describeJoinError(error: unknown): string {
  const code =
    error instanceof RelayJoinError || error instanceof RelayRequestError ? error.code : null;
  switch (code) {
    case "invalid-code":
      return error instanceof RelayJoinError && error.message.startsWith("That code is for this")
        ? error.message
        : "That code didn't work. It may have expired or been used already. Check the code on the other computer, or make a new one there.";
    case "expired":
      return "That code expired. Make a new one on the other computer.";
    case "busy":
      return "Another device is using this code right now. Wait a moment and try again.";
    case "rate-limited":
      return "Too many tries. Wait a minute, then try again.";
    case "too-many-devices":
      return "That computer already has the most devices it can have. Remove one there first.";
    case "relay-unavailable":
      return "Couldn't reach the relay. Check your internet connection and try again.";
    default:
      return error instanceof Error ? error.message : "That didn't work. Try again.";
  }
}

/** Whether "Connect to a computer" is open; anything in the app can open it. */
const useConnectComputerDialogStore = create<{ readonly open: boolean }>(() => ({ open: false }));

/**
 * Opens "Connect to a computer": from Fleet's "+", the one-computer Fleet
 * state, a computer's page, Settings › Connections and the command palette.
 */
export function openConnectComputerDialog(): void {
  useConnectComputerDialogStore.setState({ open: true });
}

/** Closes "Connect to a computer" (a fresh app in tests, a page that takes over). */
export function closeConnectComputerDialog(): void {
  useConnectComputerDialogStore.setState({ open: false });
}

/** Mounted once with the app shell: the dialog, while it is open. */
export function ConnectComputerDialogHost() {
  const open = useConnectComputerDialogStore((state) => state.open);
  return open ? (
    <Suspense fallback={null}>
      <JoinComputerDialog.Component
        open
        onOpenChange={(next) => {
          if (!next) closeConnectComputerDialog();
        }}
      />
    </Suspense>
  ) : null;
}
