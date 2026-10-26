/**
 * Notices about a linked computer this app can't reach: "isn't connected",
 * with a Reconnect button that does it in place, and the reconnect's result.
 * Only linked computers get the button; this computer's own connection has its
 * own notice (`WebSocketConnectionSurface`).
 *
 * @module computerConnectionNotices
 */
import type { EnvironmentId } from "@threadlines/contracts";

import { getSavedEnvironmentRecord, reconnectSavedEnvironment } from "./computerReconnectClient";
import {
  failureNotice,
  stackedThreadToast,
  toastManager,
  type FailureTitle,
  type NoticeAddOptions,
  type ThreadToastData,
} from "./ui/toast";

/** How long the reconnect notice spins before it says it's slow instead. */
const RECONNECT_NOTICE_WAIT_MS = 30_000;

/**
 * Reconnects a linked computer and says how it went. Given `noticeId`, the
 * notice that offered the reconnect turns into the progress and the result;
 * otherwise the result is a new notice. A reconnect that takes too long stops
 * spinning and says so, and its result arrives as a new notice once it ends.
 * Resolves whether it reconnected.
 */
export async function reconnectComputer(
  environmentId: EnvironmentId,
  label: string,
  options?: { readonly noticeId?: string },
): Promise<boolean> {
  const noticeId = options?.noticeId;
  // Every phase names its own fields: an update keeps any it doesn't name.
  const show = (notice: NoticeAddOptions, inPlace: boolean) => {
    const next = { description: undefined, actionProps: undefined, ...notice };
    if (inPlace && noticeId) toastManager.update(noticeId, next);
    else toastManager.add(next);
  };
  const outcome = reconnectSavedEnvironment(environmentId).then(
    () => ({ connected: true as const }),
    (error: unknown) => ({ connected: false as const, error }),
  );
  const report = (result: Awaited<typeof outcome>, inPlace: boolean) => {
    show(
      result.connected
        ? { type: "success", title: `Reconnected to ${label}` }
        : failureNotice({ title: `Couldn't reconnect to ${label}`, error: result.error }),
      inPlace,
    );
    return result.connected;
  };
  if (!noticeId) return report(await outcome, false);

  show({ type: "loading", title: `Reconnecting to ${label}...` }, true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<"slow">((resolve) => {
    timer = setTimeout(() => resolve("slow"), RECONNECT_NOTICE_WAIT_MS);
  });
  const first = await Promise.race([outcome, slow]);
  clearTimeout(timer);
  if (first !== "slow") return report(first, true);
  show(
    stackedThreadToast({
      type: "warning",
      title: `Still reconnecting to ${label}`,
      description: "It's taking longer than usual.",
    }),
    true,
  );
  return report(await outcome, false);
}

/**
 * Says a computer isn't connected. With `failure`, the notice is about what
 * couldn't happen ("Couldn't update the goal") and the computer is the reason;
 * without, the computer is the whole notice. `fallbackLabel` names a computer
 * this app doesn't know by name ("This computer").
 */
export function addComputerNotConnectedNotice(input: {
  readonly environmentId: EnvironmentId;
  readonly failure?: FailureTitle;
  readonly fallbackLabel?: string;
  readonly data?: ThreadToastData;
}): void {
  const linked = getSavedEnvironmentRecord(input.environmentId);
  const label = linked?.label ?? input.fallbackLabel ?? "That computer";
  let noticeId: string | null = null;
  const reconnect =
    linked === null
      ? {}
      : {
          actionProps: {
            children: "Reconnect",
            onClick: () => {
              if (noticeId !== null) {
                void reconnectComputer(linked.environmentId, linked.label, { noticeId });
              }
            },
          },
          actionVariant: "outline" as const,
        };
  const data = input.data === undefined ? {} : { data: input.data };
  noticeId = toastManager.add(
    input.failure === undefined
      ? stackedThreadToast({
          type: "error",
          title: `${label} isn't connected`,
          ...reconnect,
          ...data,
        })
      : failureNotice({
          title: input.failure,
          reason: `${label} isn't connected.`,
          ...reconnect,
          ...data,
        }),
  );
}
