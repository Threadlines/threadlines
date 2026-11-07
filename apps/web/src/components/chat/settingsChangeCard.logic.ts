/**
 * The card for an agent's settings change (docs/design/agent-settings-changes.md):
 * what each line says, whether this app can make the device changes, how this
 * device names itself in the claim, and the notice an answer ends with. Pure,
 * so the card and the claim that makes the changes read the same answers.
 */
import type {
  OrchestrationSettingsChangeRequest,
  ServerProvider,
  SettingsChangeAnswer,
  SettingsChangeDeviceReport,
  SettingsChangeItem,
  SettingsChangeValue,
} from "@threadlines/contracts";
import {
  type EditValue,
  currentPlaceId,
  NO_MODEL,
  parseModelEditValue,
  type PlaceId,
  placeById,
} from "@threadlines/shared/appPlaces";
import { type CheckedEdit, checkEdits, describeEditValue } from "@threadlines/shared/settingsEdits";

/** Where a change lands: the thread's computer, or the app the user answers in. */
export type SettingsChangeLands = "computer" | "device";

/**
 * Where a change lands, by this app's catalog. A place this app doesn't know
 * (a newer computer's) is the computer's when the computer recorded its value
 * when asked (only computer changes carry `from`), else a device change this
 * app can't make.
 */
export function settingsChangeLands(change: SettingsChangeItem): SettingsChangeLands {
  const placeId = currentPlaceId(change.place);
  const edit = placeId !== null ? placeById(placeId).edit : undefined;
  if (edit !== undefined) return edit.lands;
  return change.from !== undefined ? "computer" : "device";
}

/**
 * A value as its row shows it; a place this app doesn't know gets plain words.
 * A model reads by its name on the thread's computer, if that computer lists it.
 */
function valueLabel(
  placeId: PlaceId | null,
  value: SettingsChangeValue,
  providers: ReadonlyArray<ServerProvider>,
): string {
  if (placeId !== null && value !== NO_MODEL && placeById(placeId).edit?.control.kind === "model") {
    const parsed = parseModelEditValue(value);
    const model = providers
      .find(({ instanceId }) => instanceId === parsed?.instanceId)
      ?.models.find(({ slug }) => slug === parsed?.model);
    if (model !== undefined) return model.shortName ?? model.name;
  }
  if (placeId !== null) return describeEditValue(placeId, value);
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

/** Which provider account a model setting's value is on, as Settings names it. */
function modelAccountName(
  value: SettingsChangeValue,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const instanceId = parseModelEditValue(value)?.instanceId ?? String(value);
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  return provider?.displayName ?? provider?.auth.label ?? instanceId;
}

export interface SettingsChangeLine {
  /** The place as the agent asked, for keys. */
  readonly place: string;
  /** The place, when this app knows it: its name is a link to its row. */
  readonly placeId: PlaceId | null;
  /** The row's name as the screen shows it. */
  readonly name: string;
  readonly lands: SettingsChangeLands;
  /** What it is now: the computer's value when asked, or this device's now. Null when unknown. */
  readonly from: string | null;
  readonly to: string;
}

/**
 * The card's lines. `readDevice` reads a device setting's value in this app
 * now (client settings or the theme store); computer values are the ones the
 * computer had when the agent asked. `providers` are the thread's computer's.
 */
export function settingsChangeLines(
  request: Pick<OrchestrationSettingsChangeRequest, "changes">,
  readDevice: (placeId: PlaceId) => EditValue | undefined,
  providers: ReadonlyArray<ServerProvider> = [],
): ReadonlyArray<SettingsChangeLine> {
  return request.changes.map((change) => {
    const place = change.place.trim();
    const placeId = currentPlaceId(place);
    const lands = settingsChangeLands(change);
    const from =
      lands === "computer" ? change.from : placeId !== null ? readDevice(placeId) : undefined;
    const spec = placeId !== null ? placeById(placeId) : null;
    const fromLabel = from === undefined ? null : valueLabel(placeId, from, providers);
    const toLabel = valueLabel(placeId, change.value, providers);
    // The same model on another account: its name alone would read as no change.
    const sameName = from !== undefined && from !== change.value && fromLabel === toLabel;
    const named = (value: SettingsChangeValue, label: string) =>
      sameName ? `${label} (${modelAccountName(value, providers)})` : label;
    return {
      place: change.place,
      placeId,
      name: spec === null ? place : "editName" in spec ? spec.editName : spec.title,
      lands,
      from: from === undefined || fromLabel === null ? null : named(from, fromLabel),
      to: named(change.value, toLabel),
    };
  });
}

/**
 * Whether this app can make the request's device changes: each must be a
 * place this app's catalog lets agents change, with a value its row takes.
 * `update`: an older app; it can't take the request, so Change waits for an
 * update. `elsewhere`: this app can't hold one of them, so Change waits for
 * the app that can, or for alerts to be on here.
 */
export type SettingsChangeDeviceCheck =
  | { readonly kind: "ready"; readonly edits: ReadonlyArray<CheckedEdit> }
  | { readonly kind: "update" }
  | { readonly kind: "elsewhere"; readonly note: string };

/** What this app can hold: whether it's the desktop app, and how its phone alerts stand. */
export interface SettingsChangeDevice {
  readonly desktopApp: boolean;
  readonly alerts: "on" | "off" | "unsupported";
}

export function checkDeviceChanges(
  request: Pick<OrchestrationSettingsChangeRequest, "changes">,
  device: SettingsChangeDevice,
): SettingsChangeDeviceCheck {
  const changes = request.changes.filter((change) => settingsChangeLands(change) === "device");
  if (changes.length === 0) return { kind: "ready", edits: [] };
  const checked = checkEdits(changes.map(({ place, value }) => ({ place, value })));
  if (!("edits" in checked)) return { kind: "update" };
  const needsDesktop = checked.edits.some(({ place }) => {
    const spec = placeById(place);
    return "appliesWhen" in spec && spec.appliesWhen === "desktop";
  });
  if (needsDesktop && !device.desktopApp) {
    return {
      kind: "elsewhere",
      note: "Open this thread in the desktop app to make these changes.",
    };
  }
  const needsAlerts = checked.edits.some(
    ({ edit }) => edit.lands === "device" && "store" in edit && edit.store === "alerts",
  );
  if (needsAlerts && device.alerts !== "on") {
    return {
      kind: "elsewhere",
      note:
        device.alerts === "off"
          ? "Turn on alerts on this device to make these changes."
          : "Open this thread where you get alerts, on your phone or in a browser, to make these changes.",
    };
  }
  return { kind: "ready", edits: checked.edits };
}

/**
 * How this app names its device in a claim, read after "on" in the agent's
 * note ("On iPhone: Theme is now Light"): the desktop app by its computer's
 * name, a browser by what it is.
 */
export function settingsChangeDeviceLabel(input: {
  /** The desktop app, whose own computer runs its server. */
  readonly desktopApp: boolean;
  /** This app's computer's name, when known. */
  readonly thisComputerName: string | null;
  /** What this browser calls itself ("iPhone", "Chrome on macOS"). */
  readonly browserLabel: string;
}): string {
  if (!input.desktopApp) return input.browserLabel;
  return input.thisComputerName !== null && input.thisComputerName.trim().length > 0
    ? input.thisComputerName.trim()
    : "the desktop app";
}

export interface SettingsChangeNotice {
  readonly type: "success" | "warning" | "info";
  readonly title: string;
  readonly description?: string;
}

/** A sentence from a server's detail: starts with a capital and ends with a stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/u.test(capital) ? capital : `${capital}.`;
}

/** "Stream replies", "Stream replies and Theme", "Stream replies, Theme and Time format". */
function listNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What a claim that won ends with: what changed, and what didn't. `computer`
 * is how the computer's part ended (absent when there was none); `device` is
 * what this app made, null when it made nothing.
 */
export function settingsChangeResultNotice(input: {
  readonly lines: ReadonlyArray<SettingsChangeLine>;
  readonly computer: {
    readonly ending: "changed" | "failed" | "uncertain";
    readonly detail?: string | undefined;
  };
  readonly device: SettingsChangeDeviceReport | null;
}): SettingsChangeNotice {
  const computerLines = input.lines.filter((line) => line.lands === "computer");
  const deviceLines = input.lines.filter((line) => line.lands === "device");
  const applied = new Set(input.device?.applied ?? []);
  const changed = [
    ...(input.computer.ending === "changed" ? computerLines : []),
    ...deviceLines.filter((line) => applied.has(line.place.trim())),
  ];
  const unchangedDevice = deviceLines.filter((line) => !applied.has(line.place.trim()));
  const sentences = changed.map((line) => `${line.name} is now ${line.to}.`);
  if (computerLines.length > 0 && input.computer.ending !== "changed") {
    const names = listNames(computerLines.map((line) => line.name));
    sentences.push(
      input.computer.detail !== undefined
        ? sentence(input.computer.detail)
        : input.computer.ending === "uncertain"
          ? `Couldn't tell whether ${names} changed.`
          : `${names} didn't change.`,
    );
  }
  if (unchangedDevice.length > 0) {
    sentences.push(
      `${listNames(unchangedDevice.map((line) => line.name))} didn't change on this device.`,
    );
  }
  const allChanged = changed.length === input.lines.length;
  // The computer couldn't say what its part did: the title doesn't claim either way.
  const unsure = computerLines.length > 0 && input.computer.ending === "uncertain";
  return {
    type: allChanged ? "success" : "warning",
    title: allChanged
      ? input.lines.length === 1
        ? "Setting changed"
        : "Settings changed"
      : unsure
        ? input.lines.length === 1
          ? "Check this setting"
          : "Check these settings"
        : changed.length === 0
          ? input.lines.length === 1
            ? "The setting didn't change"
            : "The settings didn't change"
          : "Some settings didn't change",
    ...(sentences.length > 0 ? { description: sentences.join(" ") } : {}),
  };
}

/** What an answer that changed nothing here says: Not now, or someone or something got there first. */
export function settingsChangeNothingNotice(
  answer: Pick<SettingsChangeAnswer, "outcome" | "detail">,
): SettingsChangeNotice {
  switch (answer.outcome) {
    case "already_answered":
      return {
        type: "info",
        title: "Already answered",
        description: "This request was answered on another device. Nothing changed here.",
      };
    case "cancelled":
      return {
        type: "info",
        title: "Request cancelled",
        description: [
          answer.detail !== undefined ? sentence(answer.detail) : "",
          "Nothing changed.",
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      };
    case "gone":
      return {
        type: "info",
        title: "Request gone",
        description: "The agent's request isn't open anymore. Nothing changed.",
      };
    default:
      return {
        type: "info",
        title: "Nothing changed",
        description: "The agent will hear you said no.",
      };
  }
}
