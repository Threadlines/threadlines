import type {
  EnvironmentId,
  GitAuthRemediationAction,
  GitAuthRemediationActionId,
  GitRemoteAuthFailure,
} from "@threadlines/contracts";
import { describeGitRemoteAuthFailure } from "@threadlines/shared/git";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  gitApplyAuthRemediationMutationOptions,
  gitAuthRemediationPlanQueryOptions,
} from "~/lib/gitReactQuery";

export interface GitAuthRemediationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly gitCwd: string | null;
  /** The classified failure that opened the dialog; enriches the description. */
  readonly failure: GitRemoteAuthFailure | null;
  /** Called after a fix is applied so the caller can retry the failed operation. */
  readonly onResolved: () => void;
}

function RemediationCommand(props: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
        {props.command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Copy command"
        onClick={() => copyToClipboard(props.command)}
      >
        {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </Button>
    </div>
  );
}

export function GitAuthRemediationDialog(props: GitAuthRemediationDialogProps) {
  const queryClient = useQueryClient();
  const [pendingActionId, setPendingActionId] = useState<GitAuthRemediationActionId | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const plan = useQuery(
    gitAuthRemediationPlanQueryOptions({
      environmentId: props.environmentId,
      cwd: props.gitCwd,
      enabled: props.open,
    }),
  );
  const applyMutation = useMutation(
    gitApplyAuthRemediationMutationOptions({
      environmentId: props.environmentId,
      cwd: props.gitCwd,
      queryClient,
    }),
  );

  const applyAction = (action: GitAuthRemediationAction) => {
    setPendingActionId(action.id);
    setApplyError(null);
    applyMutation.mutate(
      { actionId: action.id },
      {
        onSuccess: (result) => {
          toastManager.add({
            type: "success",
            title: action.title,
            description: result.detail,
          });
          props.onResolved();
          props.onOpenChange(false);
        },
        onError: (error) => {
          setApplyError(error instanceof Error ? error.message : "The fix could not be applied.");
        },
        onSettled: () => {
          setPendingActionId(null);
        },
      },
    );
  };

  const description = props.failure
    ? describeGitRemoteAuthFailure(props.failure)
    : "Git could not authenticate to this repository's remote.";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setApplyError(null);
        }
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Fix Git authentication</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {plan.isPending ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Checking which fixes work on this machine...
            </div>
          ) : plan.isError ? (
            <div className="flex flex-col gap-2 py-2">
              <p className="text-sm text-destructive">
                {plan.error instanceof Error
                  ? plan.error.message
                  : "Could not inspect the repository remote."}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => void plan.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : plan.data.actions.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No automatic fix is available for this remote
              {plan.data.remoteUrl ? (
                <>
                  {" "}
                  (<span className="break-all font-mono text-xs">{plan.data.remoteUrl}</span>)
                </>
              ) : null}
              . Check the remote URL and your credentials in a terminal.
            </p>
          ) : (
            plan.data.actions.map((action) => (
              <div key={action.id} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{action.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{action.description}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!action.applicable || applyMutation.isPending}
                    onClick={() => applyAction(action)}
                  >
                    {pendingActionId === action.id ? <Spinner className="size-3.5" /> : "Apply"}
                  </Button>
                </div>
                <RemediationCommand command={action.command} />
                {!action.applicable && action.inapplicableReason ? (
                  <p className="text-xs text-muted-foreground">{action.inapplicableReason}</p>
                ) : null}
              </div>
            ))
          )}

          {applyError ? <p className="text-sm text-destructive">{applyError}</p> : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
