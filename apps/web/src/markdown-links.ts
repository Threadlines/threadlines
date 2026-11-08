import {
  resolveMarkdownFileLinkTarget,
  splitPathAndPosition,
  toMarkdownFileUrlHref,
} from "@threadlines/shared/chatLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

export {
  type BareImagePathMatch,
  type BareLocalhostUrlMatch,
  findBareImagePaths,
  findBareLocalhostUrls,
  isAbsoluteInlineFilePath,
  localhostUrlFromText,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
  toMarkdownFileUrlHref,
} from "@threadlines/shared/chatLinks";

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  href: string;
  displayPath: string;
  basename: string;
  line?: number;
  column?: number;
}

function basenameOfPath(path: string): string {
  const pathWithoutTrailingSeparators = path.replace(/[\\/]+$/u, "");
  if (pathWithoutTrailingSeparators.length === 0) {
    return path;
  }

  const separatorIndex = Math.max(
    pathWithoutTrailingSeparators.lastIndexOf("/"),
    pathWithoutTrailingSeparators.lastIndexOf("\\"),
  );
  return separatorIndex >= 0
    ? pathWithoutTrailingSeparators.slice(separatorIndex + 1)
    : pathWithoutTrailingSeparators;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  return targetPath ? fileLinkMetaForPath(targetPath, cwd) : null;
}

/**
 * The chip for a filesystem path (`path[:line[:column]]`) taken as written,
 * such as one a workspace search returned. Unlike a link's destination it is
 * not URL text: `%20`, `#` and `?` are part of the name.
 */
export function fileLinkMetaForPath(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitPathAndPosition(targetPath);
  const parsedLine = line ? Number.parseInt(line, 10) : Number.NaN;
  const parsedColumn = column ? Number.parseInt(column, 10) : Number.NaN;
  const lineNumber = Number.isFinite(parsedLine) ? parsedLine : undefined;
  const columnNumber = Number.isFinite(parsedColumn) ? parsedColumn : undefined;

  return {
    filePath: path,
    targetPath,
    href: toMarkdownFileUrlHref(path, { line: lineNumber, column: columnNumber }),
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    basename: basenameOfPath(path),
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    ...(columnNumber !== undefined ? { column: columnNumber } : {}),
  };
}
