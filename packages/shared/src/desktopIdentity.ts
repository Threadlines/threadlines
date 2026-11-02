// Public releases use a Threadlines-owned app id. Private alpha builds used an
// older fork-era id and should be reinstalled before moving to the public lane.
export const DESKTOP_RELEASE_APP_ID = "dev.threadlines.app";

export const DESKTOP_DEVELOPMENT_APP_ID = "dev.threadlines.app.dev";

/**
 * Where a packaged app's `package.json` names the keychain access group its
 * browser panel keeps Touch ID passkeys in. The build writes it only when it
 * signs with a provisioning profile that entitles the app to that group; the
 * app turns passkeys on only when it finds it.
 */
export const DESKTOP_PASSKEY_KEYCHAIN_GROUP_FIELD = "threadlinesWebAuthnKeychainAccessGroup";

/** The keychain access group for the browser panel's passkeys, under a signing team. */
export function desktopPasskeyKeychainGroup(teamId: string): string {
  return `${teamId}.${DESKTOP_RELEASE_APP_ID}.webauthn`;
}
