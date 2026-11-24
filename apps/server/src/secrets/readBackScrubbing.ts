/**
 * Provider text read straight from a provider's files or live state for the
 * app, with saved keys hidden (docs/design/secret-scrubbing.md, "Provider
 * text read back for an app"). Only the fields a person reads are scrubbed:
 * ids, cursors and status words go back as they are, so a key that happens
 * to equal one can't break a reply's schema or an import that sends the id
 * back.
 */
import type {
  ProviderExternalThreadCandidate,
  ProviderExternalThreadListResult,
  ProviderExternalThreadSnapshot,
  ProviderSubagentTranscriptResult,
  WorkflowReadRunFileResult,
} from "@threadlines/contracts";

import type { SecretScrubberShape } from "./SecretScrubber.ts";

type TextScrubber = Pick<SecretScrubberShape, "scrubText">;

const text = (scrubber: TextScrubber, value: string) => scrubber.scrubText(value).text;
const optionalText = <T extends string | null | undefined>(scrubber: TextScrubber, value: T): T =>
  (typeof value === "string" ? text(scrubber, value) : value) as T;

/** A subagent's or a workflow agent's transcript: what it said, ran and printed. */
export const scrubTranscript = (
  scrubber: TextScrubber,
  result: ProviderSubagentTranscriptResult,
): ProviderSubagentTranscriptResult => ({
  ...result,
  entries: result.entries.map((entry) => ({
    ...entry,
    text: text(scrubber, entry.text),
    toolUses: entry.toolUses.map((use) => ({
      ...use,
      summary: text(scrubber, use.summary),
      ...(use.description !== undefined ? { description: text(scrubber, use.description) } : {}),
    })),
    ...(entry.outputPreview !== undefined
      ? { outputPreview: text(scrubber, entry.outputPreview) }
      : {}),
  })),
  ...(result.agent?.description !== undefined
    ? { agent: { ...result.agent, description: text(scrubber, result.agent.description) } }
    : {}),
});

/** A session from outside Threadlines, as listed: its name and preview. */
const scrubCandidate = (
  scrubber: TextScrubber,
  candidate: ProviderExternalThreadCandidate,
): ProviderExternalThreadCandidate => ({
  ...candidate,
  name: optionalText(scrubber, candidate.name),
  preview: text(scrubber, candidate.preview),
});

export const scrubExternalThreadList = (
  scrubber: TextScrubber,
  result: ProviderExternalThreadListResult,
): ProviderExternalThreadListResult => ({
  ...result,
  data: result.data.map((candidate) => scrubCandidate(scrubber, candidate)),
});

/** A session from outside Threadlines, read to import: its name, preview and messages. */
export const scrubExternalThreadSnapshot = (
  scrubber: TextScrubber,
  snapshot: ProviderExternalThreadSnapshot,
): ProviderExternalThreadSnapshot => ({
  candidate: scrubCandidate(scrubber, snapshot.candidate),
  messages: snapshot.messages.map((message) => ({
    ...message,
    text: text(scrubber, message.text),
  })),
});

/** A workflow run's script or result: its text, error and logged lines. */
export const scrubWorkflowRunFile = (
  scrubber: TextScrubber,
  result: WorkflowReadRunFileResult,
): WorkflowReadRunFileResult => ({
  ...result,
  text: optionalText(scrubber, result.text),
  ...(result.error !== undefined ? { error: text(scrubber, result.error) } : {}),
  ...(result.logs !== undefined ? { logs: result.logs.map((line) => text(scrubber, line)) } : {}),
});
