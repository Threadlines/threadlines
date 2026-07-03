import type { ThreadSortInput } from "../../lib/threadSort";
import { sortScopedProjectsByActivity } from "../Sidebar.logic";

export interface SettingsProjectOption {
  readonly value: string;
  readonly label: string;
}

export function deriveSettingsProjectOptions(
  projects: ReadonlyArray<{
    readonly id: string;
    readonly environmentId: string;
    readonly cwd: string;
    readonly name: string;
    readonly createdAt?: string | undefined;
    readonly updatedAt?: string | undefined;
  }>,
  threads: ReadonlyArray<
    ThreadSortInput & {
      readonly environmentId: string;
      readonly projectId: string;
      readonly archivedAt: string | null;
    }
  > = [],
): SettingsProjectOption[] {
  const seen = new Set<string>();
  const options: SettingsProjectOption[] = [];

  // Most recently used first: latest user-message activity across the
  // project's threads, falling back to the project record's own timestamps.
  for (const project of sortScopedProjectsByActivity(projects, threads, "updated_at")) {
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
