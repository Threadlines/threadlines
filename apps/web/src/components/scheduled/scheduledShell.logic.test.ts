import { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseScheduledSearch, scheduledTaskEnvironmentsOf } from "./scheduledShell.logic";

const ENVIRONMENT = EnvironmentId.make("environment-mac");

describe("scheduledTaskEnvironmentsOf", () => {
  const runs = { repositoryIdentity: true, scheduledTasks: true };
  const older = { repositoryIdentity: true };

  it("lists only connected computers whose server runs scheduled tasks, this one first", () => {
    const listed = scheduledTaskEnvironmentsOf({
      primaryEnvironmentId: ENVIRONMENT,
      primaryDescriptor: { label: "Studio Mac", capabilities: runs },
      runtimeById: {
        [EnvironmentId.make("environment-old")]: {
          connectionState: "connected",
          descriptor: { label: "Old laptop", capabilities: older },
        },
        [EnvironmentId.make("environment-off")]: {
          connectionState: "disconnected",
          descriptor: { label: "Asleep desktop", capabilities: runs },
        },
        [EnvironmentId.make("environment-pc")]: {
          connectionState: "connected",
          descriptor: { label: "Basement PC", capabilities: runs },
        },
      },
      savedLabelOf: () => null,
    });
    expect(listed.map((environment) => environment.label)).toEqual(["Studio Mac", "Basement PC"]);
    expect(listed[0]?.isPrimary).toBe(true);
  });

  it("says which computers run event tasks, from their own capability", () => {
    const listed = scheduledTaskEnvironmentsOf({
      primaryEnvironmentId: ENVIRONMENT,
      primaryDescriptor: { label: "Studio Mac", capabilities: { ...runs, eventTasks: true } },
      runtimeById: {
        [EnvironmentId.make("environment-pc")]: {
          connectionState: "connected",
          descriptor: { label: "Basement PC", capabilities: runs },
        },
      },
      savedLabelOf: () => null,
    });
    expect(listed.map((environment) => environment.eventTasks)).toEqual([true, false]);
  });

  it("lists nothing when no server runs them, so Scheduled stays hidden", () => {
    expect(
      scheduledTaskEnvironmentsOf({
        primaryEnvironmentId: ENVIRONMENT,
        primaryDescriptor: { label: "Studio Mac", capabilities: older },
        runtimeById: {},
        savedLabelOf: () => null,
      }),
    ).toEqual([]);
  });
});

describe("parseScheduledSearch", () => {
  it("keeps a task only with its computer, and only the views it knows", () => {
    expect(parseScheduledSearch({ environment: "env", task: "task-1", view: "edit" })).toEqual({
      environment: "env",
      task: "task-1",
      view: "edit",
    });
    expect(parseScheduledSearch({ task: "task-1", view: "delete" })).toEqual({});
    expect(parseScheduledSearch({ view: "new" })).toEqual({ view: "new" });
  });
});
