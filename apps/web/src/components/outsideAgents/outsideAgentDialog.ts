/**
 * The approval and Change dialog's body (OutsideAgentDialogContent), a chunk
 * of its own: the host at the root and Settings' Agents group both render it
 * under Suspense, and the app preloads it after first paint.
 */
import { lazyWithPreload } from "../../lib/lazyWithPreload";

export const OutsideAgentDialog = lazyWithPreload(() =>
  import("./OutsideAgentDialogContent").then((module) => module.OutsideAgentDialogContent),
);

/** Fetches the dialog's body ahead of its first open. */
export const preloadOutsideAgentDialog = OutsideAgentDialog.preload;
