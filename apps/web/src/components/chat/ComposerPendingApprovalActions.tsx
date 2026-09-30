import { type ApprovalRequestId, type ProviderApprovalDecision } from "@threadlines/contracts";
import { type ComponentProps, memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  /** The answers the provider accepts. Absent: all of them. */
  availableDecisions?: ReadonlyArray<ProviderApprovalDecision> | undefined;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

const APPROVAL_ACTIONS: ReadonlyArray<{
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  readonly variant: ComponentProps<typeof Button>["variant"];
}> = [
  { decision: "cancel", label: "Cancel turn", variant: "ghost" },
  { decision: "decline", label: "Decline", variant: "destructive-outline" },
  { decision: "acceptForSession", label: "Always allow this session", variant: "outline" },
  { decision: "accept", label: "Approve once", variant: "default" },
];

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  availableDecisions,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      {APPROVAL_ACTIONS.filter(
        (action) => !availableDecisions || availableDecisions.includes(action.decision),
      ).map((action) => (
        <Button
          key={action.decision}
          size="sm"
          variant={action.variant}
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, action.decision)}
        >
          {action.label}
        </Button>
      ))}
    </>
  );
});
