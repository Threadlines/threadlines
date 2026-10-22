import { isProjectSetupCancellable, isProjectSetupFinished } from "@threadlines/client-runtime";
import type { EnvironmentId, ProjectSetupJob } from "@threadlines/contracts";
import { useMemo, useState } from "react";

import {
  cancelProjectSetup,
  describeProjectSetupFailure,
  dismissProjectSetup,
  useProjectSetupJobs,
} from "../../environments/projectSetups/projectSetups";
import { useProjectSetupComputerReady } from "../../environments/projectSetups/projectSetupTargets";
import { cn } from "../../lib/utils";
import { describeProjectSetupProgress, describeProjectSetupStage } from "../../projectSetup";
import { SETTINGS_GROUP_ROW_CLASS, SettingsGroup } from "../settings/settingsLayout";
import { useComputerLabel } from "../sidebar/linkedComputers";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * A computer's project setups on its Fleet page (docs/design/fleet.md,
 * Part 8): the ones still running and the recent ones, whoever started them,
 * with Cancel and Dismiss. Absent while it has none.
 */
export function ProjectSetupsGroup({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const jobs = useProjectSetupJobs(environmentId);
  const reachable = useProjectSetupComputerReady(environmentId);
  const ordered = useMemo(
    () => jobs.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [jobs],
  );
  if (ordered.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="fleet-project-setups">
      <h2 className="px-1 text-[15px] leading-5 font-semibold text-foreground">Setting up</h2>
      <SettingsGroup>
        {ordered.map((job) => (
          <ProjectSetupRow
            key={job.setupId}
            job={job}
            computer={{ environmentId, label }}
            reachable={reachable}
          />
        ))}
      </SettingsGroup>
    </section>
  );
}

function ProjectSetupRow({
  job,
  computer,
  reachable,
}: {
  readonly job: ProjectSetupJob;
  readonly computer: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly reachable: boolean;
}) {
  const sourceLabel = useComputerLabel()(job.source.environmentId, job.source.label);
  const [busy, setBusy] = useState(false);
  const finished = isProjectSetupFinished(job.stage);
  const progress = describeProjectSetupProgress(job);
  const act = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failure,
          description: describeProjectSetupFailure(error, `${computer.label} didn't answer.`),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}
      data-testid={`fleet-project-setup-${job.setupId}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-[13.5px] leading-[19px] font-medium text-foreground">
            {job.title}
          </p>
          <p className="text-[12.5px] leading-[18px] text-muted-foreground">
            From {sourceLabel} · {describeProjectSetupStage(job)}
            {job.progress.stalled && !finished ? (
              <span className="text-warning"> · Stalled</span>
            ) : null}
          </p>
          {progress !== null ? (
            <p className="truncate font-mono text-[11px] leading-4 text-muted-foreground">
              {progress}
            </p>
          ) : null}
          {job.stage === "failed" && job.error !== null ? (
            <p className="text-[12.5px] leading-[18px] text-destructive">{job.error}</p>
          ) : null}
          {job.stage === "done"
            ? job.warnings.map((warning) => (
                <p key={warning} className="text-[12.5px] leading-[18px] text-warning">
                  {warning}
                </p>
              ))
            : null}
        </div>
        {finished ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !reachable}
            data-testid={`fleet-project-setup-${job.setupId}-dismiss`}
            onClick={() =>
              void act(
                () => dismissProjectSetup(computer, job.setupId),
                `Could not dismiss ${job.title}`,
              )
            }
          >
            Dismiss
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !reachable || !isProjectSetupCancellable(job.stage)}
            data-testid={`fleet-project-setup-${job.setupId}-cancel`}
            onClick={() =>
              void act(
                () => cancelProjectSetup(computer, job.setupId),
                `Could not cancel setting up ${job.title}`,
              )
            }
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
