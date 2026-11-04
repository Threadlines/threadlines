/**
 * The handler behind `settings_change` (settingsChangeTools.ts): checks the
 * changes against the catalog's allowlist, drops computer changes already in
 * place, and records a request on the caller's thread for its card
 * (docs/design/agent-settings-changes.md). It never changes a setting.
 */
import {
  CommandId,
  type OrchestrationSettingsChangeRequest,
  type OrchestrationThread,
  type ServerProvider,
  type ServerSettings,
  SettingsChangeRequestId,
  type SettingsChangeItem,
  type ThreadId,
} from "@threadlines/contracts";
import { modelEditValue, placeMarkdownLink, placePathLabel } from "@threadlines/shared/appPlaces";
import {
  type CheckedEdit,
  type SettingsChangeInput,
  checkEdits,
  describeEditValue,
} from "@threadlines/shared/settingsEdits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { derivedUuid } from "../orchestration/childRequestIds.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { modelChangesProblem } from "../settingsChanges/modelChoices.ts";
import { dispatchOutcome } from "../threads/threadOperations.ts";
import { latchCallerTurn } from "./callerTurn.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { SETTINGS_CHANGE_TOOL_NAME } from "./roomToolAccess.ts";
import type { SettingsChangeResult } from "./settingsChangeTools.ts";

export interface SettingsChangeToolDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  /** This computer's stored settings, for what each computer change would change from; undefined when unreadable. */
  readonly settings: Effect.Effect<ServerSettings | undefined>;
  /** This computer's providers, for the models a model setting can take. */
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
}

const ASKED =
  "The user sees a card with these changes above their message box. Nothing changes until they accept it, and you'll hear their answer at your next turn. Tell them it's there; don't ask again meanwhile.";
const NOT_YOUR_TURN = "Settings can only be asked about during your own turn.";
const SIDE =
  "Only the thread's own agent can ask to change settings. Mention the change in your answer instead.";

/** The command id of a request: a provider's retry of the same call is the same command. */
export const settingsChangeRequestCommandId = (requestId: string) =>
  CommandId.make(`server:settings-change:${requestId}`);

/** How a recorded request stands, for a retry of the call that made it. */
function standing(request: OrchestrationSettingsChangeRequest): string {
  switch (request.status) {
    case "waiting":
    case "claimed":
      return ASKED;
    case "changed":
      return "The user already accepted this change.";
    case "declined":
      return "The user already said no to this change.";
    case "replaced":
      return "You asked for other changes since; that card replaced this one.";
    default:
      return `This change already ended: ${request.detail ?? request.status}.`;
  }
}

export function makeSettingsChangeToolHandler(deps: SettingsChangeToolDeps) {
  return (
    scope: McpInvocationScope,
    input: { readonly changes: ReadonlyArray<SettingsChangeInput> },
  ): Effect.Effect<SettingsChangeResult> =>
    Effect.gen(function* () {
      if (scope.side !== undefined || !scope.roomTools.has(SETTINGS_CHANGE_TOOL_NAME)) {
        return { outcome: "not_allowed" as const, detail: SIDE };
      }
      const checked = checkEdits(input.changes);
      if ("refused" in checked) {
        return { outcome: "refused" as const, detail: checked.refused.detail };
      }
      const latched = yield* latchCallerTurn(deps.readThread, scope);
      if ("gone" in latched) return { outcome: "refused" as const, detail: "This thread is gone." };
      if ("notYours" in latched) return { outcome: "not_allowed" as const, detail: NOT_YOUR_TURN };
      const { thread, turnId } = latched;
      if (thread.archivedAt !== null) {
        return { outcome: "refused" as const, detail: "This thread is archived." };
      }
      if ((thread.move ?? null) !== null) {
        return {
          outcome: "refused" as const,
          detail: "This thread is moving to another computer.",
        };
      }
      const stored = yield* deps.settings;
      if (stored === undefined) {
        return {
          outcome: "refused" as const,
          detail: "This computer's settings couldn't be read. Try again in a moment.",
        };
      }
      if (checked.edits.some(({ edit }) => edit.control.kind === "model")) {
        const problem = modelChangesProblem(checked.edits, stored, yield* deps.providers);
        if (problem !== null) return { outcome: "refused" as const, detail: problem };
      }
      // Computer changes already in place are left off the card.
      const items: Array<{
        readonly edit: CheckedEdit;
        readonly from?: SettingsChangeItem["from"];
      }> = [];
      const alreadySet: Array<string> = [];
      for (const edit of checked.edits) {
        if (edit.edit.lands === "computer") {
          const from = edit.edit.read(stored);
          if (from === edit.value) {
            alreadySet.push(
              `${placePathLabel(edit.place)} is already ${describeEditValue(edit.place, from)}`,
            );
            continue;
          }
          items.push({ edit, from });
        } else {
          items.push({ edit });
        }
      }
      if (items.length === 0) {
        return { outcome: "unchanged" as const, detail: `${alreadySet.join(". ")}.` };
      }
      const participant = scope.participantId ?? null;
      const requestId = SettingsChangeRequestId.make(
        derivedUuid(
          String(scope.threadId),
          participant ?? "primary",
          String(turnId),
          SETTINGS_CHANGE_TOOL_NAME,
          JSON.stringify(input.changes.map((change) => [change.place.trim(), change.value])),
        ),
      );
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const dispatched = yield* deps.engine
        .dispatch({
          type: "thread.settings-change.request",
          commandId: settingsChangeRequestCommandId(requestId),
          threadId: scope.threadId,
          requestId,
          participantId: participant,
          turnId,
          changes: items.map(({ edit, from }) => ({
            place: edit.place,
            value: edit.value,
            ...(from !== undefined ? { from } : {}),
          })),
          createdAt: now,
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(dispatchOutcome(error))),
        );
      if (dispatched !== null) {
        return { outcome: "refused" as const, detail: dispatched.detail };
      }
      // The same call again (a provider's retry) dispatched nothing new: say how it stands.
      const recorded = (yield* deps.readThread(scope.threadId))?.settingsRequests?.find(
        (request) => request.requestId === requestId,
      );
      const leftOff = alreadySet.length > 0 ? ` Left off the card: ${alreadySet.join("; ")}.` : "";
      return {
        outcome: "asked_user" as const,
        detail: `${recorded === undefined ? ASKED : standing(recorded)}${leftOff}`,
        changes: items.map(({ edit, from }) => ({
          place: edit.place,
          path: placePathLabel(edit.place),
          link: placeMarkdownLink(edit.place),
          ...(from !== undefined ? { from: describeEditValue(edit.place, from) } : {}),
          to: describeEditValue(edit.place, edit.value),
          lands: edit.edit.lands,
        })),
      };
    });
}
