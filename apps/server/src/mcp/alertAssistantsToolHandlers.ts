/**
 * The handler behind `alert_assistants` (alertAssistantsTools.ts): marks the
 * caller's running turn so its finished alert goes out when it ends, to every
 * address and subscription that takes finished alerts for the project
 * (AssistantAlerts.ask). It sends nothing itself.
 */
import type { OrchestrationThread, ProjectId, ThreadId } from "@threadlines/contracts";
import { placeMarkdownLink } from "@threadlines/shared/appPlaces";
import * as Effect from "effect/Effect";

import type { AssistantAlertsShape } from "../assistants/AssistantAlerts.ts";
import type { AlertAssistantsResult } from "./alertAssistantsTools.ts";
import { latchCallerTurn } from "./callerTurn.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { ALERT_ASSISTANTS_TOOL_NAME } from "./roomToolAccess.ts";

export interface AlertAssistantsToolDeps {
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  /** Whether the project is General Chats, which no assistant's alerts cover. */
  readonly isGeneralChat: (projectId: ProjectId) => Effect.Effect<boolean>;
  /** This computer's alerts; undefined where they don't run. */
  readonly alerts: Pick<AssistantAlertsShape, "ask"> | undefined;
}

const SIDE =
  "Only the thread's own agent can alert the user's assistants. Mention it in your answer instead.";
const NOT_YOUR_TURN = "Assistants can only be alerted during your own turn.";
const WILL_ALERT =
  "Their assistants get an alert when this turn ends, with a link to this thread. Finish the work first, and make your final reply say what the assistant needs to know.";
const ALREADY =
  "This turn's alert is already set: it goes out when the turn ends. Nothing more to do.";

const noReceiver = () =>
  `None of the user's assistants takes finished alerts for this project, so nothing would go out. To get them, add a web address (a Grok routine's webhook, say) with Finished ticked under ${placeMarkdownLink("connections.assistantAlerts")}; an assistant that subscribes through MCP Events has to subscribe to thread.finished.`;

export function makeAlertAssistantsToolHandler(deps: AlertAssistantsToolDeps) {
  return (scope: McpInvocationScope): Effect.Effect<AlertAssistantsResult> =>
    Effect.gen(function* () {
      if (scope.side !== undefined || !scope.roomTools.has(ALERT_ASSISTANTS_TOOL_NAME)) {
        return { outcome: "not_allowed" as const, detail: SIDE };
      }
      const latched = yield* latchCallerTurn(deps.readThread, scope);
      if ("gone" in latched) return { outcome: "refused" as const, detail: "This thread is gone." };
      if ("notYours" in latched) return { outcome: "not_allowed" as const, detail: NOT_YOUR_TURN };
      const { thread, turnId } = latched;
      if (thread.archivedAt !== null) {
        return { outcome: "refused" as const, detail: "This thread is archived." };
      }
      if (yield* deps.isGeneralChat(thread.projectId)) {
        return {
          outcome: "refused" as const,
          detail: "Assistants aren't alerted about General Chats.",
        };
      }
      if (deps.alerts === undefined) {
        return { outcome: "no_receiver" as const, detail: noReceiver() };
      }
      const asked = yield* deps.alerts
        .ask({ threadId: thread.id, turnId, projectId: thread.projectId })
        .pipe(Effect.result);
      if (asked._tag === "Failure") {
        return { outcome: "refused" as const, detail: asked.failure.detail };
      }
      if (asked.success.receivers === 0) {
        return { outcome: "no_receiver" as const, detail: noReceiver() };
      }
      return {
        outcome: "will_alert" as const,
        detail: asked.success.already ? ALREADY : WILL_ALERT,
      };
    });
}
