/**
 * Passkeys in the browser panel, through Touch ID.
 *
 * Electron serves WebAuthn's platform authenticator only once it is told where
 * to keep credentials: a keychain access group the app is entitled to. That
 * entitlement is restricted on macOS, so only a build signed with Threadlines'
 * provisioning profile carries it, and that build records the group in the
 * app's `package.json` for this to find. Every other build (a development run,
 * a fork, a release built without the profile) leaves passkeys off as before:
 * turning them on without the entitlement would offer pages a passkey prompt
 * that always fails.
 *
 * A passkey made here lives in this Mac's Secure Enclave, is not synced, and
 * belongs to the browser profile it was made in (Electron keeps one secret per
 * partition). Clearing browser data does not delete it.
 *
 * Passkeys saved in iCloud Keychain or a password manager are out of reach.
 * Apple serves those to an app in two ways, and neither fits here:
 * - For sites that list the app in their `apple-app-site-association` file
 *   (Associated Domains). Electron offers this as `platformPasskeys`, but it
 *   needs each site's cooperation, so it can't serve arbitrary pages.
 * - To an approved web browser holding the managed
 *   `com.apple.developer.web-browser.public-key-credential` entitlement, for
 *   any site. Apple grants it only to apps that work as the user's browser
 *   (registered to open http and https links), which Threadlines is not, and
 *   Electron has no support for that browser API.
 */

import { DESKTOP_PASSKEY_KEYCHAIN_GROUP_FIELD } from "@threadlines/shared/desktopIdentity";
import * as Electron from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The access group a packaged app was built for, or null when it was built without one. */
export function readPasskeyKeychainGroup(appPath: string): string | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(appPath, "package.json"), "utf8"));
    const group =
      typeof manifest === "object" && manifest !== null
        ? Reflect.get(manifest, DESKTOP_PASSKEY_KEYCHAIN_GROUP_FIELD)
        : undefined;
    return typeof group === "string" && group.trim() !== "" ? group.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Turns on Touch ID passkeys for the browser panel, when this build can.
 * After `ready`: Electron requires it. Returns whether they are on.
 */
export function configurePreviewPasskeys(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly appPath: string;
}): boolean {
  if (input.platform !== "darwin" || !input.isPackaged) return false;
  const keychainAccessGroup = readPasskeyKeychainGroup(input.appPath);
  if (keychainAccessGroup === null) return false;
  // macOS shows: "Threadlines" is trying to sign in to github.com.
  Electron.app.configureWebAuthn({
    touchID: { keychainAccessGroup, promptReason: "sign in to $1" },
  });
  return true;
}

/** How a passkey reads in the chooser: the name the site gave it, then the account. */
export function passkeyAccountLabel(account: Electron.WebAuthnAccount): string {
  const name = account.name?.trim() ?? "";
  const displayName = account.displayName?.trim() ?? "";
  if (displayName !== "" && name !== "" && displayName !== name) {
    return `${displayName} (${name})`;
  }
  return displayName || name || "Passkey";
}

/** The window showing a frame: the app window around a panel tab, or a sign-in pop-up. */
function windowShowing(frame: Electron.WebFrameMain | null): Electron.BrowserWindow | null {
  const contents = frame === null ? undefined : Electron.webContents.fromFrame(frame);
  if (contents === undefined || contents.isDestroyed()) return null;
  return Electron.BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
}

/**
 * Answers a page that found several of the user's passkeys for a site.
 *
 * Electron cancels the request unless someone picks one, even when only one
 * matches. One is picked as is: the user has just confirmed with Touch ID (or
 * touched their security key), which Chromium asks for before the accounts
 * arrive here. Several get a native chooser over the window showing the page.
 * The callback runs exactly once either way, or the page waits forever.
 */
export function choosePasskeyAccount(
  details: Electron.SelectWebauthnAccountDetails,
  callback: (credentialId?: string | null) => void,
): void {
  const [only, ...others] = details.accounts;
  if (only === undefined) {
    callback();
    return;
  }
  if (others.length === 0) {
    callback(only.credentialId);
    return;
  }
  const buttons = [...details.accounts.map(passkeyAccountLabel), "Cancel"];
  const options: Electron.MessageBoxOptions = {
    type: "question",
    message: `Sign in to ${details.relyingPartyId}`,
    detail: "Choose a passkey.",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  };
  const parent = windowShowing(details.frame);
  const shown =
    parent === null
      ? Electron.dialog.showMessageBox(options)
      : Electron.dialog.showMessageBox(parent, options);
  shown.then(
    ({ response }) => callback(details.accounts[response]?.credentialId ?? null),
    () => callback(),
  );
}
