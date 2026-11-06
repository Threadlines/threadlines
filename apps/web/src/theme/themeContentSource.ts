/**
 * Where the theme store finds a custom theme's content
 * (docs/design/custom-themes.md, "No flash"): this device's cache first,
 * then the entry's computer, then any other connected computer that keeps
 * themes. themeStore.ts loads this module the first time a custom theme
 * needs content, so the app starts without it.
 */
import type { ThemeContentLookup } from "./themeStoreCore";
import type { ThemeChoice } from "./themeTypes";
import { readCachedTheme } from "./themeCache";

export { peekCachedTheme, rememberThemeContent } from "./themeCache";

/**
 * A library or unsaved theme's content by hash. The runtime is imported
 * when needed, so a cached theme resolves before (and without) it.
 */
export async function lookupLibraryContent(
  choice: Extract<ThemeChoice, { kind: "library" | "unsaved" }>,
): Promise<ThemeContentLookup> {
  const cached = await readCachedTheme(choice.hash);
  if (cached) return { kind: "found", manifest: cached };
  if (choice.kind === "unsaved") return { kind: "missing" };
  const runtime = await import("../environments/runtime");
  const connections = runtime.listEnvironmentConnections();
  const ordered = [
    ...connections.filter((connection) => connection.environmentId === choice.environmentId),
    ...connections.filter((connection) => connection.environmentId !== choice.environmentId),
  ].filter(
    (connection) =>
      runtime.readEnvironmentDescriptor(connection.environmentId)?.capabilities.themes === true,
  );
  for (const connection of ordered) {
    try {
      const content = await connection.client.themes.read({ hash: choice.hash });
      if (content.hash === choice.hash) return { kind: "found", manifest: content.manifest };
    } catch {
      // Not on this computer, or it can't answer now: ask the next.
    }
  }
  const ownComputerConnected =
    choice.environmentId === null ||
    connections.some((connection) => connection.environmentId === choice.environmentId);
  return ordered.length === 0 || !ownComputerConnected ? { kind: "offline" } : { kind: "missing" };
}
