import { EnvironmentId, ProjectId, ProviderInstanceId } from "@threadlines/contracts";
import { scopeProjectRef } from "@threadlines/client-runtime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarProjectSnapshots,
  orderSnapshotsByProjectRefs,
} from "./sidebarProjectGrouping";
import type { Project } from "./types";

const primaryEnvId = EnvironmentId.make("env-primary");
const remoteEnvId = EnvironmentId.make("env-remote");

// One repository, cloned to a different path on each machine: this is the
// identity the grouping collapses on.
const SHARED_REPO = {
  canonicalKey: "github.com/example/shared",
  displayName: "shared",
  name: "shared",
};

const GROUPING_SETTINGS = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(
  overrides: Partial<Project> & Pick<Project, "id" | "environmentId" | "name">,
): Project {
  return {
    kind: "workspace",
    cwd: `/tmp/${overrides.name}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("orderSnapshotsByProjectRefs", () => {
  it("collapses a repo present on two machines onto its first appearance in the given order", () => {
    // Same repo, one checkout per machine, plus an unrelated project between
    // them in the activity order the picker was handed.
    const sharedOnRemote = makeProject({
      id: ProjectId.make("shared-remote"),
      environmentId: remoteEnvId,
      name: "shared",
      cwd: "/remote/shared",
      repositoryIdentity: SHARED_REPO,
    });
    const otherLocal = makeProject({
      id: ProjectId.make("other-local"),
      environmentId: primaryEnvId,
      name: "other",
      cwd: "/local/other",
    });
    const sharedOnPrimary = makeProject({
      id: ProjectId.make("shared-primary"),
      environmentId: primaryEnvId,
      name: "shared",
      cwd: "/local/shared",
      repositoryIdentity: SHARED_REPO,
    });
    const projects = [sharedOnRemote, otherLocal, sharedOnPrimary];

    const ordered = orderSnapshotsByProjectRefs({
      snapshots: buildSidebarProjectSnapshots({
        projects,
        settings: GROUPING_SETTINGS,
        primaryEnvironmentId: primaryEnvId,
        resolveEnvironmentLabel: () => "MacBook Pro",
      }),
      orderedProjectRefs: projects.map((project) =>
        scopeProjectRef(project.environmentId, project.id),
      ),
    });

    // Two rows, not three: the shared repo keeps the earlier of its two slots,
    // and nothing else is re-sorted around it.
    expect(ordered.map((snapshot) => snapshot.displayName)).toEqual(["shared", "other"]);
    expect(ordered[0]?.memberProjectRefs).toHaveLength(2);
    // The representative is the checkout on this machine, so a click lands
    // locally even though the remote one was seen first.
    expect(ordered[0]?.environmentId).toBe(primaryEnvId);
    expect(ordered[0]?.environmentPresence).toBe("mixed");
  });

  it("skips refs with no snapshot instead of emitting a hole", () => {
    const local = makeProject({
      id: ProjectId.make("local"),
      environmentId: primaryEnvId,
      name: "local",
    });
    const ordered = orderSnapshotsByProjectRefs({
      snapshots: buildSidebarProjectSnapshots({
        projects: [local],
        settings: GROUPING_SETTINGS,
        primaryEnvironmentId: primaryEnvId,
        resolveEnvironmentLabel: () => null,
      }),
      orderedProjectRefs: [
        scopeProjectRef(remoteEnvId, ProjectId.make("gone")),
        scopeProjectRef(primaryEnvId, local.id),
      ],
    });

    expect(ordered.map((snapshot) => snapshot.id)).toEqual([local.id]);
  });
});
