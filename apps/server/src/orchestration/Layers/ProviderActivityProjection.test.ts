import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { projectRuntimeEventToActivities } from "./ProviderActivityProjection.ts";

function mcpStatusEvent(status: unknown): ProviderRuntimeEvent {
  return {
    type: "mcp.status.updated",
    eventId: EventId.make("evt-mcp-status"),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread-1"),
    createdAt: "2026-06-01T12:00:00.000Z",
    payload: {
      status,
    },
  } satisfies ProviderRuntimeEvent;
}

describe("ProviderActivityProjection", () => {
  it("suppresses routine MCP startup status updates", () => {
    for (const status of ["starting", "ready", "connected"]) {
      expect(
        projectRuntimeEventToActivities(
          mcpStatusEvent({
            name: "github",
            status,
          }),
        ),
      ).toEqual([]);
    }

    expect(projectRuntimeEventToActivities(mcpStatusEvent("ready"))).toEqual([]);
  });

  it("keeps MCP startup failures visible", () => {
    const activities = projectRuntimeEventToActivities(
      mcpStatusEvent({
        name: "github",
        status: "failed",
        error: "OAuth token expired",
      }),
    );

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      tone: "warning",
      kind: "mcp.status.updated",
      summary: "MCP startup failed",
      payload: {
        detail: "OAuth token expired",
        status: {
          name: "github",
          status: "failed",
          error: "OAuth token expired",
        },
      },
    });
  });
});
