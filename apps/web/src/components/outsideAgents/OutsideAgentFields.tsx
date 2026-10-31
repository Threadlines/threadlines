/**
 * The fields the outside-agent dialogs share: the approval and Change dialog
 * (OutsideAgentDialogContent) and the dialog for a web address assistants'
 * alerts go to (AssistantAlertTargetDialogContent). Labels, hints, the error
 * line, and the picker for all projects or only some.
 */
import type { ProjectId } from "@threadlines/contracts";

import type { OutsideAgentProjectsChoice } from "../../environments/outsideAgents/outsideAgents.logic";
import { Checkbox } from "../ui/checkbox";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";

export const OUTSIDE_AGENT_FIELD_LABEL_CLASS = "text-xs font-medium text-foreground";
export const OUTSIDE_AGENT_HINT_CLASS = "text-[12.5px] leading-[18px] text-muted-foreground";

/** Why the last answer failed, in the server's words; nothing while none did. */
export function OutsideAgentErrorLine({ error }: { readonly error: string | null }) {
  return error !== null ? (
    <p role="alert" className="text-[12.5px] text-destructive" data-testid="outside-agent-error">
      {error}
    </p>
  ) : null;
}

/** All of this computer's projects, or the ones ticked. */
export function OutsideAgentProjectsField({
  labelId,
  projects,
  choice,
  disabled,
  onChange,
}: {
  readonly labelId: string;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
  readonly choice: OutsideAgentProjectsChoice;
  readonly disabled: boolean;
  readonly onChange: (change: Partial<OutsideAgentProjectsChoice>) => void;
}) {
  const noneTicked = projects.every((project) => !choice.projectIds.has(project.id));
  return (
    <div className="grid gap-1.5">
      <span className={OUTSIDE_AGENT_FIELD_LABEL_CLASS} id={labelId}>
        Projects
      </span>
      <SegmentedControl
        value={choice.allProjects ? "all" : "some"}
        onValueChange={(value) => onChange({ allProjects: value === "all" })}
        aria-labelledby={labelId}
        disabled={disabled}
      >
        <SegmentedControlItem value="all" data-testid="outside-agent-projects-all">
          All projects
        </SegmentedControlItem>
        <SegmentedControlItem value="some" data-testid="outside-agent-projects-some">
          Only some
        </SegmentedControlItem>
      </SegmentedControl>
      {choice.allProjects ? (
        <p className={OUTSIDE_AGENT_HINT_CLASS}>Including projects you add later.</p>
      ) : projects.length === 0 ? (
        <p className={OUTSIDE_AGENT_HINT_CLASS}>This computer has no projects yet.</p>
      ) : (
        <>
          <div
            className="surface-group max-h-44 overflow-y-auto py-1"
            data-testid="outside-agent-projects"
          >
            {projects.map((project) => {
              const checked = choice.projectIds.has(project.id);
              return (
                <label
                  key={project.id}
                  className="flex min-h-8 cursor-pointer items-center gap-2.5 px-3 py-1"
                >
                  <Checkbox
                    checked={checked}
                    disabled={disabled}
                    aria-label={project.name}
                    onCheckedChange={(next) => {
                      const projectIds = new Set(choice.projectIds);
                      if (next) projectIds.add(project.id);
                      else projectIds.delete(project.id);
                      onChange({ projectIds });
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {project.name}
                  </span>
                </label>
              );
            })}
          </div>
          {noneTicked ? <p className={OUTSIDE_AGENT_HINT_CLASS}>Tick at least one.</p> : null}
        </>
      )}
    </div>
  );
}
