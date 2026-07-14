export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

export function normalizeFilesystemPathForComparison(value: string): string {
  const trimmed = value.trim();
  const isWindowsPath = isWindowsAbsolutePath(trimmed);
  const normalized = isWindowsPath ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
  const withoutTrailingSeparators = isWindowsPath
    ? normalized.replace(/\\+$/u, "")
    : normalized.replace(/\/+$/u, "");

  if (withoutTrailingSeparators.length > 0) {
    return withoutTrailingSeparators;
  }
  return normalized.startsWith("/") ? "/" : normalized;
}

export function areFilesystemPathsEqual(left: string, right: string): boolean {
  return normalizeFilesystemPathForComparison(left) === normalizeFilesystemPathForComparison(right);
}
