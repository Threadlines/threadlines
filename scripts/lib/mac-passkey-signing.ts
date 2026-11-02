// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { desktopPasskeyKeychainGroup } from "@threadlines/shared/desktopIdentity";

/**
 * Signing a macOS release so its browser panel can use Touch ID passkeys.
 *
 * Electron keeps those passkeys in a keychain access group, and on macOS the
 * `keychain-access-groups` entitlement is restricted: a Developer ID app may
 * claim it only with an embedded provisioning profile that authorizes it.
 * Claiming it without one, or with a profile for another app, and the app
 * does not launch at all. So a profile is checked here before anything is
 * signed with it, and `notarize-after-sign.cjs` launches the signed app before
 * it is notarized. A build given no profile signs exactly as before, and the
 * app leaves passkeys off.
 */

/** What a provisioning profile says about itself, as far as passkeys care. */
export interface MacProvisioningProfileFacts {
  readonly teamId: string;
  readonly applicationIdentifier: string;
  readonly keychainAccessGroups: ReadonlyArray<string>;
  /** Developer ID profiles run on any Mac; development ones list devices. */
  readonly provisionsAllDevices: boolean;
  readonly expiresAt: Date;
}

export interface MacPasskeySigning {
  readonly teamId: string;
  /** `<team>.<app id>`, as the profile and the signature must both say. */
  readonly applicationIdentifier: string;
  readonly keychainAccessGroup: string;
}

/**
 * Whether a profile lets `appId` keep passkeys, and under which group. Throws
 * with what is wrong rather than letting a build sign with it.
 */
export function validateMacPasskeyProfile(
  profile: MacProvisioningProfileFacts,
  appId: string,
  now: Date,
): MacPasskeySigning {
  const { teamId } = profile;
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error(`The provisioning profile's team id "${teamId}" is not a team id.`);
  }
  const expected = `${teamId}.${appId}`;
  if (profile.applicationIdentifier !== expected) {
    throw new Error(
      `The provisioning profile is for "${profile.applicationIdentifier}", not "${expected}".`,
    );
  }
  if (!profile.provisionsAllDevices) {
    throw new Error(
      "The provisioning profile is not a Developer ID profile (it is limited to listed devices).",
    );
  }
  if (profile.expiresAt.getTime() <= now.getTime()) {
    throw new Error(`The provisioning profile expired on ${profile.expiresAt.toISOString()}.`);
  }
  const keychainAccessGroup = desktopPasskeyKeychainGroup(teamId);
  const authorized = profile.keychainAccessGroups.some(
    (group) => group === keychainAccessGroup || group === `${teamId}.*`,
  );
  if (!authorized) {
    throw new Error(
      `The provisioning profile does not authorize the keychain group "${keychainAccessGroup}".`,
    );
  }
  return { teamId, applicationIdentifier: expected, keychainAccessGroup };
}

/**
 * The release entitlements plus the passkey ones, for the main app only.
 * Helpers keep the base set: none of them needs the keychain, and each
 * restricted claim would need authorizing too.
 */
export function withPasskeyEntitlements(basePlist: string, signing: MacPasskeySigning): string {
  const closing = basePlist.lastIndexOf("</dict>");
  if (closing === -1) {
    throw new Error("The base entitlements file has no top-level <dict>.");
  }
  const extra = [
    "  <key>com.apple.application-identifier</key>",
    `  <string>${signing.applicationIdentifier}</string>`,
    "  <key>com.apple.developer.team-identifier</key>",
    `  <string>${signing.teamId}</string>`,
    "  <key>keychain-access-groups</key>",
    "  <array>",
    `    <string>${signing.keychainAccessGroup}</string>`,
    "  </array>",
    "",
  ].join("\n");
  return `${basePlist.slice(0, closing)}${extra}${basePlist.slice(closing)}`;
}

/** Reads a `.provisionprofile` with macOS's own tools (`security`, PlistBuddy, plutil). */
export function readMacProvisioningProfile(profilePath: string): MacProvisioningProfileFacts {
  const directory = mkdtempSync(join(tmpdir(), "threadlines-profile-"));
  try {
    const plistPath = join(directory, "profile.plist");
    writeFileSync(
      plistPath,
      execFileSync("security", ["cms", "-D", "-i", profilePath], { encoding: "utf8" }),
    );
    // PlistBuddy separates keys with ":", so entitlement names keep their dots.
    const print = (key: string): string | null => {
      try {
        return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, plistPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return null;
      }
    };
    const groups = print(":Entitlements:keychain-access-groups") ?? "";
    // An array prints as "Array {", one item per line, then "}".
    const keychainAccessGroups = groups
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && line !== "Array {" && line !== "}");
    // plutil gives the date as ISO 8601; PlistBuddy would give it in local words.
    const expires = execFileSync(
      "plutil",
      ["-extract", "ExpirationDate", "raw", "-o", "-", plistPath],
      { encoding: "utf8" },
    ).trim();
    return {
      teamId: print(":TeamIdentifier:0") ?? "",
      applicationIdentifier: print(":Entitlements:com.apple.application-identifier") ?? "",
      keychainAccessGroups,
      provisionsAllDevices: print(":ProvisionsAllDevices") === "true",
      expiresAt: new Date(expires),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Checks a profile for `appId` and writes the entitlements to sign with next to
 * the base ones. Returns what the build records in the app's `package.json`.
 */
export function prepareMacPasskeySigning(input: {
  readonly profilePath: string;
  readonly appId: string;
  readonly baseEntitlementsPath: string;
  readonly outputEntitlementsPath: string;
  readonly now?: Date;
}): MacPasskeySigning {
  const signing = validateMacPasskeyProfile(
    readMacProvisioningProfile(input.profilePath),
    input.appId,
    input.now ?? new Date(),
  );
  writeFileSync(
    input.outputEntitlementsPath,
    withPasskeyEntitlements(readFileSync(input.baseEntitlementsPath, "utf8"), signing),
  );
  return signing;
}
