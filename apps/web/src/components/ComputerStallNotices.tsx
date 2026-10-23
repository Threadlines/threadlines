/**
 * Says why a computer went quiet, once it answers again: one warning per
 * freeze its server reports (environments/stalls/computerStalls.ts), "Mac
 * mini froze for 12s. Its CPU was overloaded". A reload doesn't repeat one.
 */
import { describeComputerStall, isComputerStallRecent } from "@threadlines/client-runtime";
import type { EnvironmentId } from "@threadlines/contracts";
import { useEffect } from "react";

import { readStallComputer, useComputerStallsStore } from "../environments/stalls/computerStalls";
import { stackedThreadToast, toastManager } from "./ui/toast";

const SHOWN_STORAGE_KEY = "threadlines:computer-stall-notices";
const SHOWN_LIMIT = 50;
/** Every notice this page has shown: the storage copy is only for a reload, and can fail or forget. */
const shownThisPage = new Set<string>();

function readShown(): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(SHOWN_STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function rememberShown(key: string): void {
  try {
    sessionStorage.setItem(
      SHOWN_STORAGE_KEY,
      JSON.stringify([...readShown(), key].slice(-SHOWN_LIMIT)),
    );
  } catch {
    // Storage unavailable: a reload may say it once more.
  }
}

export function ComputerStallNotices() {
  const byEnvironmentId = useComputerStallsStore((state) => state.byEnvironmentId);

  useEffect(() => {
    const nowMs = Date.now();
    const stored = new Set(readShown());
    const notices: Array<ReturnType<typeof describeComputerStall>> = [];
    for (const [environmentId, received] of Object.entries(byEnvironmentId)) {
      if (!received || !isComputerStallRecent(received, nowMs)) continue;
      const key = `${environmentId}:${received.stall.id}`;
      if (shownThisPage.has(key) || stored.has(key)) continue;
      shownThisPage.add(key);
      rememberShown(key);
      notices.push(
        describeComputerStall(received.stall, readStallComputer(environmentId as EnvironmentId)),
      );
    }
    if (notices.length === 0) return;
    // After this commit's effects: the toast area subscribes in one of them,
    // and a toast added before it does is dropped. Not cancelled on cleanup:
    // these are already marked shown, so they must still be shown.
    window.setTimeout(() => {
      for (const notice of notices) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: notice.title,
            description: notice.description,
            data: { dismissAfterVisibleMs: 12_000, hideCopyButton: true },
          }),
        );
      }
    }, 0);
  }, [byEnvironmentId]);

  return null;
}
