import { humanizeWorkflowName } from "@threadlines/shared/workflowScript";
import { memo, useState } from "react";
import { type PendingApproval, type PendingWorkflowApproval } from "../../session-logic";
import { mcpCallLiveLabel } from "./activitySteps";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

// Tools whose detail is a shell command: render it as code.
const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "shell", "terminal"]);

function approvalHeading(approval: PendingApproval): string {
  // An MCP tool reads as what it does ("Opening a browser tab"), not its id.
  const action = approval.toolName ? mcpCallLiveLabel(approval.toolName) : null;
  if (action) return action;
  switch (approval.requestKind) {
    case "command":
      return approval.toolName && !SHELL_TOOL_NAMES.has(approval.toolName.toLowerCase())
        ? `${approval.toolName} tool approval requested`
        : "Command approval requested";
    case "file-read":
      return "File-read approval requested";
    case "file-change":
      return "File-change approval requested";
    case "terminal-input":
      return "Terminal input approval requested";
    default:
      return "Permissions approval requested";
  }
}

/**
 * A workflow asking to run: its name, the steps its script plans, and what it
 * costs, with the script one click away.
 */
function WorkflowApprovalBody({ workflow }: { workflow: PendingWorkflowApproval }) {
  const [showScript, setShowScript] = useState(false);
  const title = workflow.name ? humanizeWorkflowName(workflow.name) : "a workflow";
  return (
    <div className="space-y-1.5" data-pending-approval-workflow="true">
      <p className="text-sm font-medium text-foreground">
        Run workflow {workflow.name ? `“${title}”` : title}?
      </p>
      {workflow.description ? (
        <p className="text-[13px] text-muted-foreground">{workflow.description}</p>
      ) : null}
      {workflow.phases.length > 0 ? (
        <ol className="list-decimal space-y-0.5 pl-5 text-[13px]">
          {workflow.phases.map((phase, index) => (
            <li key={`${index}:${phase.title}`}>
              <span className="font-medium">{phase.title}</span>
              {phase.detail ? (
                <span className="text-muted-foreground"> · {phase.detail}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="text-[12.5px] text-muted-foreground">
        Runs many Claude agents in the background. Uses more of your limit than a normal turn.
      </p>
      {workflow.script ? (
        <div>
          <button
            type="button"
            className="rounded-sm text-[12.5px] text-foreground/80 outline-none hover:text-foreground focus-ring"
            aria-expanded={showScript}
            onClick={() => setShowScript((current) => !current)}
          >
            {showScript ? "Hide script" : "View script"}
          </button>
          {showScript ? (
            <pre className="mt-1.5 max-h-56 overflow-auto rounded-md bg-foreground/[0.04] p-2.5 font-mono text-[11.5px] leading-[1.5]">
              {workflow.script}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  if (approval.workflow) {
    return (
      <div className="px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
          {pendingCount > 1 ? (
            <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
          ) : null}
        </div>
        <WorkflowApprovalBody workflow={approval.workflow} />
      </div>
    );
  }
  // Shell commands and the text typed into a terminal render as code.
  const showsCode =
    approval.requestKind === "terminal-input" ||
    (approval.requestKind === "command" &&
      (!approval.toolName || SHELL_TOOL_NAMES.has(approval.toolName.toLowerCase())));

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
          <span className="text-sm font-medium">{approvalHeading(approval)}</span>
          {pendingCount > 1 ? (
            <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
          ) : null}
        </div>
        {approval.detail ? (
          showsCode ? (
            <pre
              data-testid="pending-approval-detail"
              className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all font-mono text-sm text-foreground"
            >
              {approval.detail}
            </pre>
          ) : (
            <p
              data-testid="pending-approval-detail"
              className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground"
            >
              {approval.detail}
            </p>
          )
        ) : null}
        {approval.environmentId ? (
          <p className="truncate text-xs text-muted-foreground">
            Environment: {approval.environmentId}
          </p>
        ) : null}
      </div>
    </div>
  );
});
