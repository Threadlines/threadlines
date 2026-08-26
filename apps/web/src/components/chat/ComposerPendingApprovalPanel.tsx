import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

// Tools whose detail is a shell command: render it as code.
const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "shell", "terminal"]);

function approvalHeading(approval: PendingApproval): string {
  switch (approval.requestKind) {
    case "command":
      return approval.toolName && !SHELL_TOOL_NAMES.has(approval.toolName.toLowerCase())
        ? `${approval.toolName} tool approval requested`
        : "Command approval requested";
    case "file-read":
      return "File-read approval requested";
    case "file-change":
      return "File-change approval requested";
    default:
      return "Permissions approval requested";
  }
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const isShellCommand =
    approval.requestKind === "command" &&
    (!approval.toolName || SHELL_TOOL_NAMES.has(approval.toolName.toLowerCase()));

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
          isShellCommand ? (
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
