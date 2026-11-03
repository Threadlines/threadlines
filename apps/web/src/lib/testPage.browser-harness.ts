import { cleanup } from "vitest-browser-react";

/**
 * Leaves the page empty for the next browser test: unmounts what the test
 * rendered, then clears anything else it left in `document.body`.
 *
 * Use it instead of `document.body.innerHTML = ""`. vitest-browser-react only
 * unmounts a test's components when the next test starts, so clearing the body
 * first pulls React's popup portals (menus, hover labels, dialogs, which Base UI
 * mounts straight into the body) out from under it, and that unmount then throws
 * removeChild's NotFoundError. It only throws when a popup happens to be open,
 * so it shows up as a test that fails depending on what ran before it.
 */
export async function resetTestPage(): Promise<void> {
  await cleanup();
  document.body.innerHTML = "";
}
