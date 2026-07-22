import {
  type EnvironmentId,
  type ProviderSubagentTranscriptResult,
  type ThreadId,
} from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { requireEnvironmentConnection } from "../../environments/runtime/service";

type SubagentTranscriptFetchState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly sections: ReadonlyArray<{
        readonly agentId: string;
        readonly result: ProviderSubagentTranscriptResult;
      }>;
    };

interface SubagentTranscriptProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  agentIds: ReadonlyArray<string>;
}

function keyedByContent<T>(
  values: ReadonlyArray<T>,
  keyOf: (value: T) => string,
): ReadonlyArray<{ key: string; value: T }> {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const contentKey = keyOf(value);
    const occurrence = occurrences.get(contentKey) ?? 0;
    occurrences.set(contentKey, occurrence + 1);
    return { key: `${contentKey}\u0000${occurrence}`, value };
  });
}

/** Lazily reads the provider-owned, read-only conversation for one or more
 * spawned agents. The server validates that every agent belongs to threadId. */
export function SubagentTranscript({ environmentId, threadId, agentIds }: SubagentTranscriptProps) {
  const [state, setState] = useState<SubagentTranscriptFetchState>({ status: "loading" });
  const agentIdsKey = agentIds.join("\u0000");

  useEffect(() => {
    const requestedAgentIds = agentIdsKey.split("\u0000").filter((agentId) => agentId.length > 0);
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const connection = requireEnvironmentConnection(environmentId);
        const sections: Array<{ agentId: string; result: ProviderSubagentTranscriptResult }> = [];
        for (const agentId of requestedAgentIds) {
          const result = await connection.client.server.readSubagentTranscript({
            threadId,
            agentId,
          });
          sections.push({ agentId, result });
        }
        if (!cancelled) {
          setState({ status: "loaded", sections });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              cause instanceof Error && cause.message.trim().length > 0
                ? cause.message
                : "Failed to load the subagent transcript.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentIdsKey, environmentId, threadId]);

  return (
    <div data-subagent-transcript="true">
      <p className="mb-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/55 uppercase">
        Read-only transcript
      </p>
      {state.status === "loading" ? (
        <p className="text-[11px] text-muted-foreground/60">Loading transcript...</p>
      ) : state.status === "error" ? (
        <p className="text-[11px] text-muted-foreground/60" data-subagent-transcript-error="true">
          {state.message}
        </p>
      ) : (
        state.sections.map((section) => (
          <div key={section.agentId} className="space-y-1.5">
            {state.sections.length > 1 ? (
              <p className="font-mono text-[10px] text-muted-foreground/50">
                Agent {section.agentId}
              </p>
            ) : null}
            {keyedByContent(
              section.result.entries,
              (entry) =>
                `${entry.role}\u0000${entry.text}\u0000${entry.outputPreview ?? ""}\u0000${entry.toolUses
                  .map((toolUse) => `${toolUse.name}\u0000${toolUse.summary}`)
                  .join("\u0001")}`,
            ).map(({ key: entryKey, value: entry }) => (
              <div
                key={`${section.agentId}:${entryKey}`}
                data-subagent-transcript-entry={entry.role}
              >
                {entry.role === "thinking" ? (
                  <p className="text-[11px] leading-4 text-muted-foreground/50 italic">
                    {entry.text}
                  </p>
                ) : entry.text.length > 0 ? (
                  <p className="text-[11px] leading-4 whitespace-pre-wrap wrap-break-word">
                    <span className="mr-1 text-[9px] tracking-[0.08em] text-muted-foreground/50 uppercase">
                      {entry.role}
                    </span>
                    {entry.text}
                  </p>
                ) : null}
                {entry.toolUses.length > 0 ? (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {keyedByContent(
                      entry.toolUses,
                      (toolUse) => `${toolUse.name}\u0000${toolUse.summary}`,
                    ).map(({ key: toolKey, value: toolUse }) => (
                      <span
                        key={`${section.agentId}:${entryKey}:${toolKey}`}
                        className="inline-flex max-w-full items-center rounded border border-border/55 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/75"
                        title={toolUse.summary || toolUse.name}
                      >
                        <span className="min-w-0 truncate">
                          {toolUse.summary ? `${toolUse.name}: ${toolUse.summary}` : toolUse.name}
                        </span>
                      </span>
                    ))}
                  </div>
                ) : null}
                {entry.outputPreview ? (
                  <pre className="mt-0.5 max-h-40 overflow-y-auto rounded-md border border-border/45 bg-background/70 px-2 py-1 font-mono text-[10px] leading-4 whitespace-pre-wrap wrap-break-word text-muted-foreground/70">
                    {entry.outputPreview}
                  </pre>
                ) : null}
              </div>
            ))}
            {section.result.truncated ? (
              <p className="text-[10px] text-muted-foreground/50">
                Transcript truncated to the first {section.result.entries.length} entries.
              </p>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
