export interface SettingsProjectOption {
  readonly value: string;
  readonly label: string;
}

export function deriveSettingsProjectOptions(
  projects: ReadonlyArray<{
    readonly cwd: string;
    readonly name: string;
    readonly updatedAt?: string | undefined;
  }>,
): SettingsProjectOption[] {
  const seen = new Set<string>();
  const options: SettingsProjectOption[] = [];

  for (const project of projects.toSorted((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
  )) {
    const cwd = project.cwd.trim();
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    options.push({
      value: cwd,
      label: project.name,
    });
  }

  return options;
}
