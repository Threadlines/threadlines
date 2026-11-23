/**
 * A project's lead chat (docs/design/lead-chat.md): one ordinary thread the
 * project points at with `leadThreadId`. The decider enforces these rules and
 * the client reads the same ones to explain a disabled menu item.
 */
import { CHILD_THREADS_PER_CALL, type ProjectId, type ThreadId } from "@threadlines/contracts";

/** What the lead rules read from a project. */
export interface LeadProject {
  readonly id: ProjectId;
  readonly kind: "workspace" | "general-chat";
  readonly leadThreadId?: ThreadId | null | undefined;
}

/** What the lead rules read from a thread. */
export interface LeadThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId | null;
  readonly attachedToParent: boolean;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null | undefined;
  readonly remoteOrigin?: unknown;
  readonly outsideOrigin?: unknown;
  readonly move?: unknown;
  readonly pendingMove?: unknown;
}

/**
 * The project's lead thread id, or null. A pointer at a thread that is gone,
 * archived or in another project counts as none, so replaying old events or
 * a cascade an older build missed never leaves a ghost lead.
 */
export function projectLeadThreadId(
  project: Pick<LeadProject, "id" | "leadThreadId"> | null | undefined,
  findThread: (threadId: ThreadId) => LeadThread | null | undefined,
): ThreadId | null {
  const leadThreadId = project?.leadThreadId ?? null;
  if (project === null || project === undefined || leadThreadId === null) return null;
  const thread = findThread(leadThreadId);
  if (
    thread === null ||
    thread === undefined ||
    (thread.deletedAt ?? null) !== null ||
    thread.archivedAt !== null ||
    thread.projectId !== project.id
  ) {
    return null;
  }
  return leadThreadId;
}

/**
 * Why `thread` cannot become its project's lead chat, in words for the user,
 * or null. The client adds the reasons only it knows (the "Agents can start
 * threads" setting).
 */
export function leadSetRefusal(project: LeadProject, thread: LeadThread): string | null {
  if (project.kind === "general-chat") return "General Chats can't have a lead chat.";
  if (thread.projectId !== project.id) return "That thread is in another project.";
  if ((thread.deletedAt ?? null) !== null) return "That thread was deleted.";
  if (thread.archivedAt !== null) return "Archived threads can't be the lead chat.";
  if (thread.parentThreadId !== null && thread.attachedToParent) {
    return "This thread belongs to the thread that started it. Make it its own thread first.";
  }
  if ((thread.remoteOrigin ?? null) !== null) {
    return "This thread was started from another computer.";
  }
  if ((thread.outsideOrigin ?? null) !== null) {
    return "This thread was started by an outside agent.";
  }
  if ((thread.move ?? null) !== null || (thread.pendingMove ?? null) !== null) {
    return "This thread is moving to another computer.";
  }
  return null;
}

/** The words a lead's thread refuses a move with. */
export const LEAD_MOVE_REFUSAL = "This is the project's lead chat. Pick another lead first.";

/**
 * Context added to every turn that starts in the lead (decision 5: per-turn
 * context, so every provider hears it and Claude's system prompt stays the
 * same across threads).
 */
export function leadRoleText(projectTitle: string): string {
  return [
    `This thread is the lead chat for the project "${projectTitle}". The user drops work here and you coordinate it.`,
    "- Answer quick questions yourself. Do not change files in this thread.",
    '- For work, call thread_list with scope "project" first. If an open thread already works in that area, pass the message on with thread_send. Otherwise start one thread per independent task with thread_start, each with a brief that stands on its own.',
    "- Say in a line or two what went where. When a report comes back, tell the user what finished and what needs them. Do not repeat the report.",
    "- Threads you started report back by themselves. Do not poll them. A thread you did not start does not report back: the user sees its answer there.",
    "- Rules the user gives you for the whole project belong in a project note, so the threads you start get them.",
    `- Start as many threads and send as many messages as the work needs, at most ${CHILD_THREADS_PER_CALL} threads per call.`,
  ].join("\n");
}

/** Added to the role text when the lead's agent came up without the thread tools. */
export const LEAD_WITHOUT_TOOLS_TEXT =
  "This agent has no thread tools here, so it cannot start or message threads. Tell the user that this agent can't coordinate the lead chat and that another agent can, and answer what you can yourself.";
