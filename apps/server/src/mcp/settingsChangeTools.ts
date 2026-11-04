/**
 * `settings_change`: an agent asks to change Threadlines settings for the user
 * (docs/design/agent-settings-changes.md). The call only puts a card in front
 * of the user; nothing changes until they accept it. Served on the room
 * endpoint wherever `app_guide` is, never to a side runtime.
 *
 * Agents without instructions (ACP) learn when to use it from the
 * description alone, so the description carries the rules.
 */
import { MAX_SETTINGS_CHANGES } from "@threadlines/shared/settingsEdits";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { GUIDE_TOOL_NAME, SETTINGS_CHANGE_TOOL_NAME } from "./roomToolAccess.ts";

/** One setting on the card, as the user will see it. */
export const SettingsChangeShown = Schema.Struct({
  place: Schema.String,
  /** Where the setting is, as the screen shows it. */
  path: Schema.String,
  /** A markdown link to it, for your reply. */
  link: Schema.String,
  /** Its value now. Absent for settings each app keeps: the server can't see them. */
  from: Schema.optional(Schema.String),
  to: Schema.String,
  /** "computer": this computer's settings. "device": the app the user accepts it in. */
  lands: Schema.Literals(["computer", "device"]),
});

export const SettingsChangeResult = Schema.Struct({
  outcome: Schema.Literals(["asked_user", "unchanged", "refused", "not_allowed"]),
  detail: Schema.String,
  changes: Schema.optional(Schema.Array(SettingsChangeShown)),
});
export type SettingsChangeResult = typeof SettingsChangeResult.Type;

export const SettingsChangeTool = Tool.make(SETTINGS_CHANGE_TOOL_NAME, {
  description: `Change Threadlines settings the user asked you to change: the theme, streaming replies, the model new threads start with, alert switches and the like. It shows the user a card above their message box with the changes, and nothing changes until they accept it; their answer reaches you at your next turn, so don't ask again meanwhile. Only settings ${GUIDE_TOOL_NAME} marks as ones an agent can change: look the setting up there first for its place id and the values it takes. Settings that give agents more reach (starting threads, rooms, access, linked computers, plugins) are the user's alone: give them the link instead. Use it only for a change the user asked for, never on your own initiative.`,
  parameters: Schema.Struct({
    changes: Schema.Array(
      Schema.Struct({
        place: Schema.String.annotate({
          description: `The setting's place id from ${GUIDE_TOOL_NAME} (its link is threadlines-place:<id>), e.g. "general.theme".`,
        }),
        value: Schema.Union([Schema.Boolean, Schema.String, Schema.Number]).annotate({
          description:
            "The new value: true or false for a switch, a choice's value as the guide lists it, or a whole number.",
        }),
      }),
    ).annotate({
      description: `1 to ${MAX_SETTINGS_CHANGES} settings, each once. They go on one card.`,
    }),
  }),
  success: SettingsChangeResult,
})
  // It only shows a card: the user makes the change, so providers that ask
  // before every non-read-only tool don't ask twice.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Title, "Change Threadlines settings");

export const SettingsChangeToolkit = Toolkit.make(SettingsChangeTool);
