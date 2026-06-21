import { scopeThreadRef } from "@threadlines/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@threadlines/contracts";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveDraftCanonicalThreadRef(input: {
  draftPromotedTo?: ScopedThreadRef | null | undefined;
  serverThreadRef?: ScopedThreadRef | null | undefined;
  serverThreadHasTurnActivity: boolean;
}): ScopedThreadRef | null {
  const target = input.draftPromotedTo ?? input.serverThreadRef ?? null;
  if (!target || !input.serverThreadHasTurnActivity) {
    return null;
  }
  if (
    input.serverThreadRef &&
    (input.serverThreadRef.environmentId !== target.environmentId ||
      input.serverThreadRef.threadId !== target.threadId)
  ) {
    return null;
  }
  return target;
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}
