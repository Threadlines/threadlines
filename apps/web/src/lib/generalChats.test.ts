import { scopeProjectRef } from "@threadlines/client-runtime";
import { EnvironmentId, GENERAL_CHATS_PROJECT_ID, ProjectId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveGeneralChatsProjectRef, scopeGeneralChatsProjectRef } from "./generalChats";

const ACTIVE_ENVIRONMENT_ID = EnvironmentId.make("environment-active");
const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make("environment-primary");

describe("generalChats", () => {
  it("scopes the stable General Chats project id to an environment", () => {
    expect(scopeGeneralChatsProjectRef(ACTIVE_ENVIRONMENT_ID)).toEqual(
      scopeProjectRef(ACTIVE_ENVIRONMENT_ID, GENERAL_CHATS_PROJECT_ID),
    );
  });

  it("falls back to the active environment before the projected system project exists", () => {
    expect(
      resolveGeneralChatsProjectRef({
        generalChatsProject: null,
        activeEnvironmentId: ACTIVE_ENVIRONMENT_ID,
        primaryEnvironmentId: PRIMARY_ENVIRONMENT_ID,
      }),
    ).toEqual(scopeProjectRef(ACTIVE_ENVIRONMENT_ID, GENERAL_CHATS_PROJECT_ID));
  });

  it("uses the projected system project when it is available", () => {
    const projectedProjectId = ProjectId.make("project-projected-general-chats");

    expect(
      resolveGeneralChatsProjectRef({
        generalChatsProject: {
          environmentId: PRIMARY_ENVIRONMENT_ID,
          id: projectedProjectId,
        },
        activeEnvironmentId: ACTIVE_ENVIRONMENT_ID,
        primaryEnvironmentId: null,
      }),
    ).toEqual(scopeProjectRef(PRIMARY_ENVIRONMENT_ID, projectedProjectId));
  });
});
