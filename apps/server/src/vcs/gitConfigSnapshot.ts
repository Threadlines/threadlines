/**
 * A checkout's effective git config, read once with `git config -z --list`.
 *
 * Status reads need half a dozen settings (remotes, a branch's remote and
 * merge base, remote URLs). Reading them with one process instead of one
 * `git config --get` each is the point; the answers must match what those
 * single reads would have said. The list is read per checkout, never shared
 * between worktrees: includes, conditional includes and worktree config can
 * differ from one checkout to the next.
 */
export interface GitConfigSnapshot {
  /** As `git config --get <key>` answers: the last value, trimmed; null when unset or empty. */
  readonly get: (key: string) => string | null;
  /** Remotes configured in git config, in the order `git remote` lists them. */
  readonly remoteNames: ReadonlyArray<string>;
}

interface ParsedConfigKey {
  readonly section: string;
  readonly subsection: string | null;
  readonly variable: string;
}

/**
 * Git compares section and variable names without case and subsection names
 * (a branch or remote name) with it. Subsections may themselves hold dots.
 */
function parseConfigKey(key: string): ParsedConfigKey | null {
  const firstDot = key.indexOf(".");
  const lastDot = key.lastIndexOf(".");
  if (firstDot <= 0 || lastDot === key.length - 1) {
    return null;
  }
  return {
    section: key.slice(0, firstDot).toLowerCase(),
    subsection: firstDot === lastDot ? null : key.slice(firstDot + 1, lastDot),
    variable: key.slice(lastDot + 1).toLowerCase(),
  };
}

function canonicalConfigKey(key: ParsedConfigKey): string {
  return key.subsection === null
    ? `${key.section}.${key.variable}`
    : `${key.section}.${key.subsection}.${key.variable}`;
}

/** Bytewise, as git sorts the names `git remote` prints. */
function compareBytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Parses `git config -z --list`: entries end in NUL, and each holds the key,
 * then a newline and the value. A key with no newline after it was written
 * without a value.
 */
export function parseGitConfigList(stdout: string): GitConfigSnapshot {
  const values = new Map<string, string | null>();
  const remoteNames = new Set<string>();
  for (const entry of stdout.split("\0")) {
    if (entry.length === 0) {
      continue;
    }
    const newline = entry.indexOf("\n");
    const parsed = parseConfigKey(newline === -1 ? entry : entry.slice(0, newline));
    if (parsed === null) {
      continue;
    }
    values.set(canonicalConfigKey(parsed), newline === -1 ? null : entry.slice(newline + 1));
    if (parsed.section === "remote" && parsed.subsection !== null) {
      remoteNames.add(parsed.subsection);
    }
  }
  return {
    get: (key) => {
      const parsed = parseConfigKey(key);
      const value = parsed === null ? undefined : values.get(canonicalConfigKey(parsed));
      const trimmed = value?.trim();
      return trimmed ? trimmed : null;
    },
    remoteNames: [...remoteNames].toSorted(compareBytewise),
  };
}
