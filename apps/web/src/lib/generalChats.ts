import { scopeProjectRef } from "@threadlines/client-runtime";
import {
  GENERAL_CHATS_PROJECT_ID,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
} from "@threadlines/contracts";

interface GeneralChatsProjectIdentity {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

export function scopeGeneralChatsProjectRef(
  environmentId: EnvironmentId | null | undefined,
): ScopedProjectRef | null {
  return environmentId ? scopeProjectRef(environmentId, GENERAL_CHATS_PROJECT_ID) : null;
}

export function resolveGeneralChatsProjectRef(input: {
  readonly generalChatsProject: GeneralChatsProjectIdentity | null;
  readonly activeEnvironmentId: EnvironmentId | null | undefined;
  readonly primaryEnvironmentId?: EnvironmentId | null | undefined;
}): ScopedProjectRef | null {
  if (input.generalChatsProject) {
    return scopeProjectRef(input.generalChatsProject.environmentId, input.generalChatsProject.id);
  }

  return scopeGeneralChatsProjectRef(input.activeEnvironmentId ?? input.primaryEnvironmentId);
}
