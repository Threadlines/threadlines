"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";

import type { NoticeAddOptions, ThreadToastData } from "./toast";

export type StackedThreadToastOptions = {
  type: "error" | "warning" | "success" | "info" | "loading";
  title: ReactNode;
  description?: ReactNode;
  /** Only 0, "stay until closed"; a custom duration goes in `data.dismissAfterVisibleMs`. */
  timeout?: 0;
  priority?: "low" | "high";
  actionProps?: ComponentPropsWithoutRef<"button">;
  /** Merged into `data`; `actionLayout` is always forced to `"stacked-end"` by the helper. */
  actionVariant?: ThreadToastData["actionVariant"];
  data?: Omit<ThreadToastData, "actionLayout">;
};

/**
 * Thread toast using the stacked body: title and reason on their own lines,
 * copy beside close for errors, buttons in a row underneath.
 */
export function stackedThreadToast(options: StackedThreadToastOptions): NoticeAddOptions {
  const { type, title, description, timeout, priority, actionProps, actionVariant, data } = options;

  // Helper-owned `actionLayout` must win over any caller-provided `data`, so spread
  // the caller's data first and apply `actionLayout: "stacked-end"` last.
  const mergedData: ThreadToastData = {
    ...(data !== undefined ? data : {}),
    actionLayout: "stacked-end",
  };
  if (actionVariant !== undefined) {
    mergedData.actionVariant = actionVariant;
  }

  const payload: NoticeAddOptions = {
    type,
    title,
    data: mergedData,
  };

  if (description !== undefined) {
    payload.description = description;
  }
  if (timeout !== undefined) {
    payload.timeout = timeout;
  }
  if (priority !== undefined) {
    payload.priority = priority;
  }
  if (actionProps !== undefined) {
    payload.actionProps = actionProps;
  }

  return payload;
}
