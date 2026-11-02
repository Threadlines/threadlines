/**
 * What an agent is told about a settings change it asked for, at its next
 * turn (docs/design/agent-settings-changes.md, "The note"). Worded from the
 * request as it ended: the computer's part as settled, the device part as the
 * claiming app reported it, or as unconfirmed when it never did.
 */
import type {
  OrchestrationSettingsChangeRequest,
  SettingsChangeItem,
} from "@threadlines/contracts";
import { isPlaceId, placeById, placePathLabel } from "@threadlines/shared/appPlaces";
import { describeEditValue } from "@threadlines/shared/settingsEdits";

const landsOnDevice = (change: SettingsChangeItem) =>
  isPlaceId(change.place) && placeById(change.place).edit?.lands === "device";

const nameOf = (change: SettingsChangeItem) =>
  isPlaceId(change.place) ? placePathLabel(change.place) : change.place;

const valueOf = (change: SettingsChangeItem) =>
  isPlaceId(change.place) ? describeEditValue(change.place, change.value) : String(change.value);

const nowIs = (changes: ReadonlyArray<SettingsChangeItem>) =>
  changes.map((change) => `${nameOf(change)} is now ${valueOf(change)}`).join("; ");

const asked = (changes: ReadonlyArray<SettingsChangeItem>) =>
  changes.map((change) => `${nameOf(change)} to ${valueOf(change)}`).join(", ");

/** The device part, once the claim won: as the app reported it, or unconfirmed. */
function devicePart(request: OrchestrationSettingsChangeRequest): string | undefined {
  const changes = request.changes.filter(landsOnDevice);
  if (changes.length === 0) return undefined;
  const where = request.claim?.deviceLabel ?? "the device they answered from";
  const report = request.device;
  if (report === undefined) {
    return `Their app on ${where} didn't confirm the change there (${asked(changes)}).`;
  }
  const applied = changes.filter((change) => report.applied.includes(change.place));
  return [
    applied.length > 0 ? `On ${where}: ${nowIs(applied)}.` : undefined,
    ...report.failed.map((failure) => {
      const change = changes.find((entry) => entry.place === failure.place);
      return `${change === undefined ? failure.place : nameOf(change)} couldn't be changed on ${where}: ${failure.detail}`;
    }),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

/** The note for one settled request, or null when the agent needn't hear (it replaced it). */
export function settingsChangeNote(request: OrchestrationSettingsChangeRequest): string | null {
  const computer = request.changes.filter((change) => !landsOnDevice(change));
  const detail = request.detail !== undefined ? ` ${request.detail}` : "";
  switch (request.status) {
    case "changed": {
      const parts = [
        "The user accepted your settings change.",
        computer.length > 0 ? `On this computer: ${nowIs(computer)}.` : undefined,
        devicePart(request),
      ];
      return parts.filter((part): part is string => part !== undefined).join(" ");
    }
    case "failed":
    case "uncertain": {
      const parts = [
        computer.length > 0
          ? `The user accepted your settings change, but on this computer it didn't all go through.${detail}`
          : `The user accepted your settings change.${detail}`,
        devicePart(request),
      ];
      return parts.filter((part): part is string => part !== undefined).join(" ");
    }
    case "declined":
      return `The user said no to your settings change (${asked(request.changes)}). Don't ask again unless they bring it up.`;
    case "cancelled":
      return `Your settings change (${asked(request.changes)}) was cancelled before the user answered.${detail}`;
    case "replaced":
    case "waiting":
    case "claimed":
      return null;
  }
}
