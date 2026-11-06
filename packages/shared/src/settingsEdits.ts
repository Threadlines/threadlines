/**
 * Agents' settings changes (docs/design/agent-settings-changes.md): whether a
 * change is one an agent may ask for, whether its value fits the row, how
 * values read on screen, and the one patch a set of changes writes. The
 * `settings_change` tool, the computer answering a card and the app making
 * its device changes all use these, so they agree on what a change means.
 */
import type { ClientSettingsPatch, ServerSettingsPatch } from "@threadlines/contracts";
import * as Duration from "effect/Duration";

import {
  type AppPlaceEdit,
  type EditControl,
  type EditValue,
  NO_MODEL,
  type PlaceId,
  THEME_LABELS,
  isPlaceId,
  parseModelEditValue,
  placeById,
  placeMarkdownLink,
  placePathLabel,
} from "./appPlaces.ts";

/** The most changes one card holds. */
export const MAX_SETTINGS_CHANGES = 8;

export interface SettingsChangeInput {
  readonly place: string;
  readonly value: EditValue;
}

/** A change that passed `checkEdits`: a place agents may change, with a value its row takes. */
export interface CheckedEdit {
  readonly place: PlaceId;
  readonly value: EditValue;
  readonly edit: AppPlaceEdit;
}

export type EditRefusalReason =
  | "count"
  | "unknown"
  | "user_only"
  | "not_editable"
  | "duplicate"
  | "bad_value"
  | "no_one_app";

export interface EditRefusal {
  readonly reason: EditRefusalReason;
  /** For the agent: what's wrong, with the place's link where there is one. */
  readonly detail: string;
}

/** The edit agents may make at a place, or null. */
export function placeEdit(place: PlaceId): AppPlaceEdit | null {
  return placeById(place).edit ?? null;
}

/**
 * Whether `value` is one the control takes: a boolean, an offered choice, a
 * whole number in range, or a model's name. Whether this computer offers that
 * model is for the tool to check (modelChoices.ts).
 */
export function editValueFits(control: EditControl, value: unknown): value is EditValue {
  switch (control.kind) {
    case "switch":
      return typeof value === "boolean";
    case "choice":
      return typeof value === "string" && Object.hasOwn(control.options, value);
    case "count":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        ((value >= control.min && value <= control.max) ||
          (control.offAtZero === true && value === 0))
      );
    case "model":
      return value === NO_MODEL
        ? control.noneLabel !== undefined
        : parseModelEditValue(value) !== null;
    case "theme":
      return typeof value === "string" && value.trim().length > 0 && value.length <= 60;
  }
}

/** What a control takes, said for an agent. */
export function describeEditControl(control: EditControl): string {
  switch (control.kind) {
    case "switch":
      return "true (on) or false (off)";
    case "choice":
      return `one of ${Object.entries(control.options)
        .map(([value, label]) => `"${value}" (${label})`)
        .join(", ")}`;
    case "count":
      return `a whole number of ${control.unit} from ${control.min} to ${control.max}${
        control.offAtZero === true ? ", or 0 for off" : ""
      }`;
    case "model":
      return `"<instanceId>/<model>" for a model this computer offers, at its default reasoning${
        control.noneLabel !== undefined ? `, or "${NO_MODEL}" for ${control.noneLabel}` : ""
      }`;
    case "theme":
      return '"system", "light", "dark", or the name of a starter theme or a theme in this computer\'s library';
  }
}

/**
 * Checks a whole request: every change must be a place agents may change,
 * once, with a value its row takes. One bad change refuses them all.
 */
export function checkEdits(
  changes: ReadonlyArray<SettingsChangeInput>,
): { readonly edits: ReadonlyArray<CheckedEdit> } | { readonly refused: EditRefusal } {
  if (changes.length === 0 || changes.length > MAX_SETTINGS_CHANGES) {
    return {
      refused: {
        reason: "count",
        detail: `Change 1 to ${MAX_SETTINGS_CHANGES} settings at a time.`,
      },
    };
  }
  const seen = new Set<string>();
  const edits: CheckedEdit[] = [];
  for (const change of changes) {
    const place = change.place.trim();
    if (!isPlaceId(place)) {
      return {
        refused: {
          reason: "unknown",
          detail: `"${place}" isn't a place in Threadlines. Look the setting up with app_guide and use the id it gives.`,
        },
      };
    }
    const spec = placeById(place);
    if (spec.widensAgents === true) {
      return {
        refused: {
          reason: "user_only",
          detail: `Only the user can change ${placeMarkdownLink(place)}: it gives agents more reach. Give them the link instead.`,
        },
      };
    }
    if (spec.edit === undefined) {
      return {
        refused: {
          reason: "not_editable",
          detail: `Agents can't change ${placeMarkdownLink(place)}. Give the user the link to change it there.`,
        },
      };
    }
    if (seen.has(place)) {
      return {
        refused: {
          reason: "duplicate",
          detail: `${placePathLabel(place)} is in the list twice.`,
        },
      };
    }
    seen.add(place);
    if (!editValueFits(spec.edit.control, change.value)) {
      return {
        refused: {
          reason: "bad_value",
          detail: `${placePathLabel(place)} takes ${describeEditControl(spec.edit.control)}, not ${JSON.stringify(change.value)}.`,
        },
      };
    }
    edits.push({ place, value: change.value, edit: spec.edit });
  }
  // Alerts need a phone or browser and these rows the desktop app: no one app can accept both.
  const alert = edits.find(({ edit }) => "store" in edit && edit.store === "alerts");
  const desktop = edits.find(({ place }) => {
    const spec = placeById(place);
    return "appliesWhen" in spec && spec.appliesWhen === "desktop";
  });
  if (alert !== undefined && desktop !== undefined) {
    return {
      refused: {
        reason: "no_one_app",
        detail: `${placePathLabel(alert.place)} changes on a phone or in a browser and ${placePathLabel(desktop.place)} in the desktop app, so no one app can accept both. Ask for them separately.`,
      },
    };
  }
  return { edits };
}

/** A setting's value as its row shows it: "On", "Light", "12 px", "Off". */
export function describeEditValue(place: PlaceId, value: EditValue): string {
  const spec = placeById(place);
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    const control = spec.edit?.control;
    if (control?.kind === "count") {
      return value === 0 && control.offAtZero === true ? "Off" : `${value} ${control.unit}`;
    }
    return String(value);
  }
  const control = spec.edit?.control;
  if (control?.kind === "theme") {
    return (THEME_LABELS as Readonly<Record<string, string>>)[value] ?? value;
  }
  if (control?.kind === "model") {
    return value === NO_MODEL
      ? (control.noneLabel ?? value)
      : (parseModelEditValue(value)?.model ?? value);
  }
  // The guide's labels cover every value a setting takes; an agent's options
  // may offer fewer (a current value can still be one agents can't pick).
  const labels =
    spec.value?.kind === "choice"
      ? spec.value.options
      : spec.edit?.control.kind === "choice"
        ? spec.edit.control.options
        : {};
  return labels[value] ?? value;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !Duration.isDuration(value);

/** Merges patches so two edits under one nested setting each keep their own leaf. */
function mergePatches<P extends object>(patches: ReadonlyArray<P>): P {
  const merged: Record<string, unknown> = {};
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch)) {
      const existing = merged[key];
      merged[key] =
        isPlainRecord(existing) && isPlainRecord(value) ? { ...existing, ...value } : value;
    }
  }
  return merged as P;
}

/** The one settings write a computer makes for its changes. */
export function composeServerPatch(edits: ReadonlyArray<CheckedEdit>): ServerSettingsPatch {
  return mergePatches(
    edits.flatMap(({ edit, value }) => (edit.lands === "computer" ? [edit.patch(value)] : [])),
  );
}

/** The one client-settings write an app makes for its device changes (the theme is apart). */
export function composeClientPatch(edits: ReadonlyArray<CheckedEdit>): ClientSettingsPatch {
  return mergePatches(
    edits.flatMap(({ edit, value }) =>
      edit.lands === "device" && "patch" in edit ? [edit.patch(value)] : [],
    ),
  );
}
