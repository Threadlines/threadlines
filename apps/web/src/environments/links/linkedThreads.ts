/**
 * Children on computers this app can't see, opened read through the link
 * (docs/design/child-threads.md, "Opening a child on a computer the app
 * can't see"). The parent's computer reads the child from the computer it
 * runs on (`links.readThread`), so the app needs no connection of its own
 * there. LinkedThreadView draws it at `/linked/$computerId/$linkedThreadId`.
 */
import { scopeThreadRef } from "@threadlines/client-runtime";
import type {
  AgentThreadReadResult,
  EnvironmentId,
  LinksReadThreadInput,
  ScopedThreadRef,
  ThreadId,
} from "@threadlines/contracts";

import { readEnvironmentConnection } from "../runtime";

/** The route params that open `ref` read through the link. */
export function linkedThreadRouteParams(ref: ScopedThreadRef): {
  computerId: string;
  linkedThreadId: string;
} {
  return { computerId: ref.environmentId, linkedThreadId: ref.threadId };
}

/** The child a `/linked/...` route opens; null when the params don't name one. */
export function resolveLinkedThreadRouteRef(
  params: Partial<Record<"computerId" | "linkedThreadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.computerId || !params.linkedThreadId) return null;
  return scopeThreadRef(params.computerId as EnvironmentId, params.linkedThreadId as ThreadId);
}

/** A page of the child's messages, asked of the parent's computer. */
export async function readLinkedThread(
  parentEnvironmentId: EnvironmentId,
  input: LinksReadThreadInput,
): Promise<AgentThreadReadResult> {
  const connection = readEnvironmentConnection(parentEnvironmentId);
  if (connection === null) {
    throw new Error("This app isn't connected to the computer that started it.");
  }
  return connection.client.links.readThread(input);
}
