import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project, SidebarThreadSummary, ThreadSession } from "./types";
import {
  groupAutoArchiveCandidatesByProject,
  resolveAutoArchivePreviewDays,
  selectAutoArchiveCandidates,
} from "./threadAutoArchive";

const NOW_MS = Date.parse("2026-06-18T12:00:00.000Z");
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-a");

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * 24 * 60 * 60 * 1_000).toISOString();
}

function runningSession(): ThreadSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    status: "running",
    activeTurnId: TurnId.make("turn-running"),
    createdAt: daysAgo(40),
    updatedAt: daysAgo(40),
    orchestrationStatus: "running",
  };
}

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: daysAgo(45),
    archivedAt: null,
    pinnedAt: null,
    updatedAt: daysAgo(45),
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: daysAgo(45),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("thread auto-archive candidates", () => {
  it("uses 30 days as the off-state preview threshold", () => {
    expect(resolveAutoArchivePreviewDays(0)).toBe(30);
    expect(resolveAutoArchivePreviewDays(60)).toBe(60);
  });

  it("selects inactive unprotected threads", () => {
    const candidates = selectAutoArchiveCandidates({
      inactiveDays: 30,
      nowMs: NOW_MS,
      threads: [
        thread("eligible"),
        thread("recent", { updatedAt: daysAgo(10), latestUserMessageAt: daysAgo(10) }),
        thread("archived", { archivedAt: daysAgo(31) }),
        thread("pinned", { pinnedAt: daysAgo(31) }),
        thread("running", { session: runningSession() }),
        thread("approval", { hasPendingApprovals: true }),
        thread("input", { hasPendingUserInput: true }),
        thread("plan", { hasActionableProposedPlan: true }),
      ],
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual([ThreadId.make("eligible")]);
  });

  it("uses updatedAt as the inactivity timestamp when available", () => {
    const candidates = selectAutoArchiveCandidates({
      inactiveDays: 30,
      nowMs: NOW_MS,
      threads: [
        thread("old-created-recent-update", {
          createdAt: daysAgo(90),
          latestUserMessageAt: daysAgo(90),
          updatedAt: daysAgo(2),
        }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("groups candidates by project", () => {
    const project: Project = {
      id: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      kind: "workspace" as const,
      name: "Project A",
      cwd: "/tmp/project-a",
      defaultModelSelection: null,
      scripts: [],
    };
    const candidates = selectAutoArchiveCandidates({
      inactiveDays: 30,
      nowMs: NOW_MS,
      threads: [thread("one"), thread("two")],
    });

    expect(groupAutoArchiveCandidatesByProject({ candidates, projects: [project] })).toMatchObject([
      {
        count: 2,
        project: {
          name: "Project A",
        },
      },
    ]);
  });
});
