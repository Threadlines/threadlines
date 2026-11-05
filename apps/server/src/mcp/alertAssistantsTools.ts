/**
 * `alert_assistants`: an agent the user asked to tell their always-on
 * assistant (a Grok Bot routine, say) marks its turn, and the turn's finished
 * alert goes out when it ends (docs/design/assistants.md, "Alerts when
 * asked"). Served on the room endpoint wherever `app_guide` is, never to a
 * side runtime.
 *
 * Agents without instructions (ACP) learn when to use it from the
 * description alone, so the description carries the rules.
 */
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ALERT_ASSISTANTS_TOOL_NAME } from "./roomToolAccess.ts";

export const AlertAssistantsResult = Schema.Struct({
  outcome: Schema.Literals(["will_alert", "no_receiver", "refused", "not_allowed"]),
  detail: Schema.String,
});
export type AlertAssistantsResult = typeof AlertAssistantsResult.Type;

export const AlertAssistantsTool = Tool.make(ALERT_ASSISTANTS_TOOL_NAME, {
  description:
    "Alert the user's always-on assistants (Grok Bot, say) about this thread once your current turn ends. Use it only when the user asked you to tell, ping or notify their assistant, e.g. \"let Grok know when you're done\", and call it in the turn that finishes what they asked about. The alert carries only that this thread finished, its project and a link; the assistant then reads the thread itself, so make your final reply say what it needs to know. One alert per turn: calling it again in the same turn changes nothing.",
  // No `parameters`: Tool.make's default lists as an empty object. An empty
  // `Schema.Struct({})` lists as "object or array", and Claude then rejects
  // the whole room endpoint's tool list.
  success: AlertAssistantsResult,
})
  // It only sends the user's own assistant the alert the user asked for, so
  // providers that ask before every non-read-only tool don't ask again.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Title, "Alert your assistants");

export const AlertAssistantsToolkit = Toolkit.make(AlertAssistantsTool);
