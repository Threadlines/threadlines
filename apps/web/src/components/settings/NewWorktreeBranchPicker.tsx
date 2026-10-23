import type { VcsRef } from "@threadlines/contracts";
import { isTemporaryWorktreeBranch, settingBranchName } from "@threadlines/shared/git";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { gitBranchesAcrossCheckoutsQueryOptions } from "../../lib/gitReactQuery";
import { useServerConfig } from "../../rpc/serverState";
import { selectProjectsForEnvironment, useStore } from "../../store";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";

/** Branches shown at once; a search reaches the rest. */
const SHOWN_LIMIT = 100;

export interface BranchChoice {
  readonly name: string;
  /** The projects that have the branch, by name. */
  readonly projects: ReadonlyArray<string>;
}

/**
 * Branch names across several projects' refs, each with the projects that
 * have it: most shared first, then in each project's own order (its current
 * and default branches, then the most recent). A remote branch counts under
 * the name the setting finds it by (`origin/develop` is `develop`);
 * throwaway thread branches are left out.
 */
export function branchChoicesAcrossProjects(
  projects: ReadonlyArray<{
    readonly name: string;
    readonly refs: ReadonlyArray<Pick<VcsRef, "name" | "isRemote" | "remoteName">>;
  }>,
): BranchChoice[] {
  const byName = new Map<string, { readonly order: number; readonly projects: string[] }>();
  for (const project of projects) {
    for (const ref of project.refs) {
      const name = settingBranchName(ref);
      if (isTemporaryWorktreeBranch(name)) continue;
      const entry = byName.get(name);
      if (entry === undefined) {
        byName.set(name, { order: byName.size, projects: [project.name] });
      } else if (!entry.projects.includes(project.name)) {
        entry.projects.push(project.name);
      }
    }
  }
  return [...byName.entries()]
    .toSorted(
      ([, left], [, right]) =>
        right.projects.length - left.projects.length || left.order - right.order,
    )
    .map(([name, entry]) => ({ name, projects: entry.projects }));
}

function projectsNote(projects: ReadonlyArray<string>): string {
  return projects.length <= 2 ? projects.join(", ") : `${projects.length} projects`;
}

/**
 * Picks the branch new worktrees start from (Settings › Threads). The setting
 * covers every project on the computer, so the list gathers the branches of
 * all of them, each noting which projects have it.
 */
export function NewWorktreeBranchPicker({
  value,
  onChange,
  open,
  onOpenChange,
  className,
}: {
  readonly value: string;
  readonly onChange: (branch: string) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly className?: string;
}) {
  // The computer these settings belong to (the paired one on a phone).
  const environmentId = useServerConfig()?.environment.environmentId ?? null;
  const projects = useStore(
    useShallow((state) =>
      selectProjectsForEnvironment(state, environmentId).filter(
        (project) => project.kind !== "general-chat",
      ),
    ),
  );
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim());
  const branches = useQuery({
    ...gitBranchesAcrossCheckoutsQueryOptions({
      environmentId,
      cwds: projects.map((project) => project.cwd),
      query: search,
      enabled: open,
    }),
    placeholderData: keepPreviousData,
  });
  const choices = useMemo(
    () =>
      branchChoicesAcrossProjects(
        projects.map((project, index) => ({
          name: project.name,
          refs: branches.data?.[index]?.refs ?? [],
        })),
      ),
    [branches.data, projects],
  );
  // Narrowed here too, so the list follows each keystroke before the
  // search comes back; the branch named exactly what was typed leads.
  const typed = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (typed.length === 0) return choices.slice(0, SHOWN_LIMIT);
    const matching = choices.filter((choice) => choice.name.toLowerCase().includes(typed));
    return [
      ...matching.filter((choice) => choice.name.toLowerCase() === typed),
      ...matching.filter((choice) => choice.name.toLowerCase() !== typed),
    ].slice(0, SHOWN_LIMIT);
  }, [choices, typed]);
  const names = useMemo(() => shown.map((choice) => choice.name), [shown]);
  const hasMore =
    choices.length > SHOWN_LIMIT || (branches.data?.some((page) => page.hasMore) ?? false);
  const emptyText =
    projects.length === 0
      ? "Add a project to pick from its branches."
      : branches.isPending
        ? "Loading branches…"
        : "No branch matches.";

  return (
    <Combobox
      items={names}
      filteredItems={names}
      value={value.length > 0 ? value : null}
      autoHighlight
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
      onValueChange={(next) => {
        if (typeof next === "string" && next.length > 0) onChange(next);
      }}
    >
      <ComboboxTrigger
        render={<SelectButton className={className} aria-label="Branch new worktrees start from" />}
      >
        {value.length > 0 ? value : <span className="text-muted-foreground">Pick a branch</span>}
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-80">
        <div className="border-b p-1">
          <ComboboxInput
            className="rounded-md [&_input]:font-sans"
            inputClassName="ring-0"
            placeholder="Search branches"
            aria-label="Search branches"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {shown.map((choice, index) => (
            <ComboboxItem
              key={choice.name}
              index={index}
              value={choice.name}
              contentClassName="min-w-0"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                {projects.length > 1 ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {projectsNote(choice.projects)}
                  </span>
                ) : null}
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
        {hasMore && typed.length === 0 ? (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            Type to search every branch.
          </p>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}
