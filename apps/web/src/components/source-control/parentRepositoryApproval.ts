import type { EnvironmentId, VcsStatusResult } from "@threadlines/contracts";
import { create } from "zustand";

/**
 * The one checkout, inside a repository rooted above it, that the user agreed
 * to change through that parent repository. It lasts while the app is open;
 * the Source tab grants it and anything that changes the checkout (the Source
 * tab's actions, the chat header's pull) reads it.
 */
const useParentRepositoryApprovalStore = create<{ readonly approvedKey: string | null }>(() => ({
  approvedKey: null,
}));

export interface ParentRepositoryApproval {
  /** The parent repository's root when the checkout sits inside one, else null. */
  readonly parentRepositoryRoot: string | null;
  /** True until the user agrees to change this checkout through its parent. */
  readonly confirmationRequired: boolean;
  /** Agrees (true) or takes the agreement back (false). */
  readonly setApproved: (approved: boolean) => void;
}

export function useParentRepositoryApproval(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly status: VcsStatusResult | null;
}): ParentRepositoryApproval {
  const { environmentId, cwd, status } = input;
  const approvedKey = useParentRepositoryApprovalStore((state) => state.approvedKey);
  const parentRepositoryRoot =
    status?.isRepo && status.repositoryRootRelation === "ancestor"
      ? (status.repositoryRoot ?? null)
      : null;
  const key =
    environmentId && cwd && parentRepositoryRoot
      ? `${environmentId}\0${cwd}\0${parentRepositoryRoot}`
      : null;
  return {
    parentRepositoryRoot,
    confirmationRequired: key !== null && approvedKey !== key,
    setApproved: (approved) =>
      useParentRepositoryApprovalStore.setState({ approvedKey: approved ? key : null }),
  };
}

export function resetParentRepositoryApprovalForTests(): void {
  useParentRepositoryApprovalStore.setState({ approvedKey: null });
}
