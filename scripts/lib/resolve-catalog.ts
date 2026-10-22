/**
 * The package a dependency or pnpm override key names. Override keys may carry
 * a version selector (`vite@*`, `@scope/pkg@^1`), and a bare `catalog:` spec
 * resolves by the package name, the way pnpm resolves it.
 */
function packageNameOf(key: string): string {
  const versionSeparator = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return versionSeparator === -1 ? key : key.slice(0, versionSeparator);
}

/**
 * Resolve `catalog:` dependency specs using the workspace catalog.
 *
 * Pure function: returns a new record with every `catalog:…` value replaced by
 * the concrete version string found in `catalog`. Throws on missing entries.
 * Works for dependency maps and for the workspace `overrides` map.
 */
export function resolveCatalogDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  label: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [name, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      const lookupKey = catalogKey.length > 0 ? catalogKey : packageNameOf(name);
      const resolved = catalog[lookupKey];

      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error(
          `Unable to resolve '${spec}' for ${label} dependency '${name}'. Expected key '${lookupKey}' in root workspace catalog.`,
        );
      }

      return [name, resolved];
    }),
  );
}
