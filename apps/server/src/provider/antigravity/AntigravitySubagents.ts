/**
 * Antigravity's subagents for the generic ACP core (`AcpProviderDescriptor.subagents`).
 *
 * The agent launches a subagent with an `invoke_subagent` tool call (older
 * builds: `start_subagent`) that returns at once; the child works on and
 * later reports to the parent, which wakes and replies (1.5.10). ACP carries
 * nothing more, so which child a call started, whether it reported or was
 * killed, and its steps come from the CLI's own records
 * (`AntigravityChildRecords`).
 *
 * @module provider/antigravity/AntigravitySubagents
 */
import * as Effect from "effect/Effect";

import type { AcpSubagentState, AcpSubagents } from "../acp/AcpProviderDescriptor.ts";
import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import {
  antigravityChildLaunches,
  antigravityChildStates,
  antigravityChildTranscript,
} from "./AntigravityChildRecords.ts";

/** The titles a subagent launch arrives under, asked or auto-approved. */
const LAUNCH_TITLES = new Set([
  "Running start_subagent",
  "Run start_subagent?",
  "Running invoke_subagent",
  "Run invoke_subagent?",
  // agy 1.5 titles an auto-approved call this way (T3 Code 43b37b6d3c).
  "Run invoke_subagent",
]);

/** Whether this tool call launches subagents: its title, and an input naming them. */
export function isAntigravitySubagentLaunch(toolCall: AcpToolCallState): boolean {
  return (
    (toolCall.kind === undefined || toolCall.kind === "other") &&
    toolCall.title !== undefined &&
    LAUNCH_TITLES.has(toolCall.title) &&
    antigravityChildLaunches(toolCall.data.rawInput) !== undefined
  );
}

/** The subagent hooks, reading the records in this instance's profile. */
export function antigravitySubagents(profileDir: string): AcpSubagents {
  return {
    launches: (toolCall) =>
      isAntigravitySubagentLaunch(toolCall)
        ? antigravityChildLaunches(toolCall.data.rawInput)
        : undefined,
    states: ({ sessionId, launchCallIds }) =>
      antigravityChildStates(profileDir, sessionId, launchCallIds).pipe(
        Effect.map((children) =>
          children === undefined
            ? undefined
            : new Map(
                [...children].map(([id, child]): [string, AcpSubagentState] => [
                  id,
                  {
                    state: child.state,
                    ...(child.report !== undefined ? { report: child.report } : {}),
                  },
                ]),
              ),
        ),
      ),
    transcript: ({ sessionId, launchCallId }) =>
      antigravityChildTranscript(profileDir, sessionId, launchCallId).pipe(
        Effect.map((read) =>
          read === undefined
            ? undefined
            : {
                childId: read.child.conversationId,
                launch: read.child.launch,
                entries: read.entries,
                truncated: read.truncated,
              },
        ),
      ),
    unrecordedMessage:
      "Antigravity did not record which subagent this started, so its steps can't be shown.",
  };
}
