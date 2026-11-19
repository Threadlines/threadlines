/**
 * Settings › Instructions › Brief (docs/design/project-brief-notes.md): the
 * picked project's brief, saved on every connected computer that has the
 * project. Shown only when the picked project's computer keeps briefs.
 *
 * Mount it keyed by the picked project: a pick starts with a clean draft.
 */
import {
  type EnvironmentId,
  PROJECT_BRIEF_MAX_CHARS,
  type ProjectBrief,
} from "@threadlines/contracts";
import { LoaderIcon, SaveIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import {
  briefIn,
  type BriefSaveOutcome,
  type BriefTarget,
  computerInSentence,
  describeBriefSave,
  PROJECT_BRIEF_COUNT_FROM,
  saveBriefOn,
  useProjectBriefSnapshots,
  useProjectBriefSupport,
} from "../../projectBrief";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

const BRIEF_ABOUT =
  "Every thread in this project gets this, on any agent. New threads get a change at once. Open threads get it the next time their agent starts. It stays on your computers and is not written to your repository.";

/** The user's edit, and the revision on the picked computer it started from. */
interface BriefDraft {
  readonly text: string;
  readonly baseRevision: number;
}

/** What the line under the box says, until the next edit. */
type BriefNotice =
  | { readonly kind: "result"; readonly text: string }
  /** The picked computer refused the save: another device saved first. */
  | { readonly kind: "stale"; readonly mine: string };

/** The newer of two copies of one computer's brief: a save's answer can beat its snapshot. */
function newer(left: ProjectBrief | null, right: ProjectBrief | null): ProjectBrief | null {
  if (left === null) return right;
  if (right === null) return left;
  return right.revision > left.revision ? right : left;
}

export function ProjectBriefSection({
  project,
  projects,
  computerLabel,
}: {
  /** The picked project. */
  project: Project;
  /** Every workspace project this app knows, on every computer. */
  projects: readonly Project[];
  /** A computer's name as the page shows it. */
  computerLabel: (environmentId: EnvironmentId) => string;
}) {
  const groupingSettings = useSettings(selectProjectGroupingSettings);
  const supports = useProjectBriefSupport();

  // The picked copy first, then the project's copies on other computers (the
  // ones the sidebar shows as the same project).
  const targets = useMemo((): readonly BriefTarget[] => {
    const settings = {
      sidebarProjectGroupingMode: groupingSettings.sidebarProjectGroupingMode,
      sidebarProjectGroupingOverrides: groupingSettings.sidebarProjectGroupingOverrides,
    };
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, settings);
    const toTarget = (copy: Project): BriefTarget => ({
      environmentId: copy.environmentId,
      projectId: copy.id,
      label: computerLabel(copy.environmentId),
      supported: supports(copy.environmentId),
    });
    const others = projects
      .filter(
        (copy) =>
          !(copy.environmentId === project.environmentId && copy.id === project.id) &&
          deriveLogicalProjectKeyFromSettings(copy, settings) === logicalKey,
      )
      .map(toTarget)
      .toSorted((left, right) => left.label.localeCompare(right.label));
    return [toTarget(project), ...others];
  }, [
    computerLabel,
    groupingSettings.sidebarProjectGroupingMode,
    groupingSettings.sidebarProjectGroupingOverrides,
    project,
    projects,
    supports,
  ]);
  const picked = targets[0]!;
  const followed = useMemo(
    () =>
      targets
        .filter((target) => target.supported)
        .map((target) => target.environmentId)
        .filter((id, index, ids) => ids.indexOf(id) === index),
    [targets],
  );
  const snapshots = useProjectBriefSnapshots(followed);

  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [notice, setNotice] = useState<BriefNotice | null>(null);
  const [saving, setSaving] = useState(false);
  /** Each computer's brief as a save answered it, until its snapshot catches up. */
  const [answered, setAnswered] = useState<Readonly<Record<string, ProjectBrief>>>({});

  const briefOn = (target: BriefTarget): ProjectBrief | null =>
    newer(
      briefIn(snapshots[target.environmentId], target.projectId),
      answered[`${target.environmentId}\n${target.projectId}`] ?? null,
    );
  const pickedBrief = briefOn(picked);
  const text = draft?.text ?? pickedBrief?.text ?? "";
  const dirty = draft !== null && pickedBrief !== null && draft.text !== pickedBrief.text;

  if (!picked.supported) return null;

  const remember = (outcomes: readonly BriefSaveOutcome[], sent: readonly BriefTarget[]) => {
    setAnswered((previous) => {
      const next = { ...previous };
      outcomes.forEach((outcome, index) => {
        if (outcome.kind !== "saved" && outcome.kind !== "stale") return;
        const target = sent[index]!;
        next[`${target.environmentId}\n${target.projectId}`] = outcome.brief;
      });
      return next;
    });
  };

  const save = async () => {
    if (draft === null || pickedBrief === null || saving) return;
    const sending = draft.text;
    setSaving(true);
    try {
      const first = await saveBriefOn(picked, sending, draft.baseRevision);
      remember([first], [picked]);
      if (first.kind === "stale") {
        // Theirs stays; the box shows it, and the user's text can come back.
        setDraft(null);
        setNotice({ kind: "stale", mine: sending });
        return;
      }
      if (first.kind !== "saved") {
        setNotice({ kind: "result", text: describeBriefSave([first]) });
        return;
      }
      const others = targets.slice(1);
      const rest = await Promise.all(
        others.map((target) => saveBriefOn(target, sending, briefOn(target)?.revision ?? 0)),
      );
      remember(rest, others);
      setDraft(null);
      setNotice({ kind: "result", text: describeBriefSave([first, ...rest]) });
    } finally {
      setSaving(false);
    }
  };

  const copyTo = async (target: BriefTarget) => {
    if (pickedBrief === null || saving) return;
    setSaving(true);
    try {
      const outcome = await saveBriefOn(target, pickedBrief.text, briefOn(target)?.revision ?? 0);
      remember([outcome], [target]);
      setNotice({ kind: "result", text: describeBriefSave([outcome]) });
    } finally {
      setSaving(false);
    }
  };

  // Copies elsewhere that hold another brief, once they have said; offered
  // only while nothing here is unsaved, since Save would reach them anyway.
  const differing =
    dirty || pickedBrief === null || notice?.kind === "stale"
      ? []
      : targets.slice(1).filter((target) => {
          const theirs = briefOn(target);
          return theirs !== null && theirs.text !== pickedBrief.text;
        });

  return (
    <SettingsSection place="instructions.brief">
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <textarea
          value={text}
          disabled={pickedBrief === null}
          // Held while saving, so what is sent is what the box shows.
          readOnly={saving}
          maxLength={PROJECT_BRIEF_MAX_CHARS}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setDraft((current) => ({
              text: next,
              baseRevision: current?.baseRevision ?? pickedBrief?.revision ?? 0,
            }));
            if (notice !== null) setNotice(null);
          }}
          rows={6}
          placeholder="Rules every thread in this project should follow, like which branch to start from."
          aria-label="Project brief"
          className="min-h-28 w-full resize-y rounded-lg bg-field px-3 py-2 text-[13px] leading-relaxed text-foreground shadow-(--field-shadow) outline-none transition-shadow placeholder:text-muted-foreground focus-ring disabled:opacity-60"
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <p className="text-xs leading-[18px] text-muted-foreground">{BRIEF_ABOUT}</p>
          <div className="flex shrink-0 items-center justify-end gap-2.5">
            {text.length >= PROJECT_BRIEF_COUNT_FROM ? (
              <span
                className="font-mono text-[11px] text-muted-foreground tabular-nums"
                data-testid="project-brief-count"
              >
                {text.length.toLocaleString()} / {PROJECT_BRIEF_MAX_CHARS.toLocaleString()}
              </span>
            ) : null}
            <Button
              size="xs"
              aria-label="Save brief"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <SaveIcon className="size-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>
        {notice?.kind === "result" ? (
          <p role="status" className="text-xs leading-[18px] text-foreground">
            {notice.text}
          </p>
        ) : notice?.kind === "stale" ? (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-xs leading-[18px] text-foreground">
              Another device saved this brief first. Its text is shown, and your edit was not saved.
            </p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setDraft({ text: notice.mine, baseRevision: pickedBrief?.revision ?? 0 });
                setNotice(null);
              }}
            >
              Bring back my edit
            </Button>
          </div>
        ) : null}
        {differing.map((target) => (
          <div
            key={`${target.environmentId}\n${target.projectId}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
          >
            <p className="text-xs leading-[18px] text-muted-foreground">
              {target.label} has a different brief.
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => void copyTo(target)}
            >
              Use this brief on {computerInSentence(target.label)} too
            </Button>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
