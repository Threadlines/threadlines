/**
 * What the phones, tablets and browsers using a computer are called, the
 * same in Fleet and in Settings › Connections.
 */
import type { AuthClientMetadata } from "@threadlines/contracts";

/** A device's sign-in on a computer, as far as its name goes. */
export interface NamedDevice {
  readonly sessionId: string;
  /** When it paired, for telling apart two that would read the same. */
  readonly issuedAt: string;
  readonly client: Pick<AuthClientMetadata, "name" | "label" | "deviceType" | "os" | "browser">;
}

/** A device's name: what the computer's user named it, else deviceOwnName. */
export function deviceDisplayName(client: NamedDevice["client"]): string {
  return client.name ?? deviceOwnName(client);
}

/**
 * What a device is called without a name from the user: what it called
 * itself ("iPhone"), else its system and browser, else its kind.
 */
export function deviceOwnName(client: NamedDevice["client"]): string {
  return (
    client.label ??
    ([client.os, client.browser].filter(Boolean).join(" · ") ||
      (client.deviceType === "mobile"
        ? "Phone"
        : client.deviceType === "tablet"
          ? "Tablet"
          : "Unnamed device"))
  );
}

const PAIRED_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const PAIRED_DAY_AND_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatPairedAt(issuedAt: string, withTime: boolean): string {
  const date = new Date(issuedAt);
  return (withTime ? PAIRED_DAY_AND_TIME : PAIRED_DAY).format(date);
}

/**
 * Every device's name as a list of them shows it, by session id. Two that
 * would read the same and that nobody named yet also say when they paired
 * ("iPhone (paired Oct 20)"), with the time when that was the same day too.
 * A named device is shown as named: naming it is how the user tells it apart.
 */
export function deviceDisplayNames(
  devices: ReadonlyArray<NamedDevice>,
  formatPaired: (issuedAt: string, withTime: boolean) => string = formatPairedAt,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const unnamedByName = new Map<string, NamedDevice[]>();
  for (const device of devices) {
    const name = deviceDisplayName(device.client);
    names.set(device.sessionId, name);
    if (device.client.name !== undefined) continue;
    const same = unnamedByName.get(name) ?? [];
    same.push(device);
    unnamedByName.set(name, same);
  }
  for (const [name, same] of unnamedByName) {
    const named = devices.some(
      (device) => device.client.name !== undefined && deviceDisplayName(device.client) === name,
    );
    if (same.length < 2 && !named) continue;
    const days = same.map((device) => formatPaired(device.issuedAt, false));
    for (const [index, device] of same.entries()) {
      const sameDay = days.filter((day) => day === days[index]).length > 1;
      names.set(device.sessionId, `${name} (paired ${formatPaired(device.issuedAt, sameDay)})`);
    }
  }
  return names;
}
