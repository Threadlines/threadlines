/**
 * The workflow view's Script and Result tabs: the run's own files, read from
 * the server on demand (workflowRunClient). A result is read once the run
 * has ended; Claude writes it then.
 */
import type {
  EnvironmentId,
  OrchestrationWorkflowRun,
  ThreadId,
  WorkflowReadRunFileResult,
  WorkflowRunFileKind,
} from "@threadlines/contracts";
import { useEffect, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { readWorkflowRunFile } from "./workflowRunClient";

type FileState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "loaded"; readonly file: WorkflowReadRunFileResult };

function useWorkflowRunFile(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly file: WorkflowRunFileKind;
  /** Read again when this changes (the run ending makes a result appear). */
  readonly revision: string;
}): FileState {
  const [state, setState] = useState<FileState>({ status: "loading" });
  const { environmentId, threadId, taskId, file, revision } = input;
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    readWorkflowRunFile({ environmentId, threadId, taskId, file })
      .then((result) => {
        if (!cancelled) setState({ status: "loaded", file: result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "The file could not be read.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, threadId, taskId, file, revision]);
  return state;
}

const UNAVAILABLE_WORDS: Readonly<Record<string, string>> = {
  hidden: "Claude keeps the script of its built-in workflows to itself.",
  missing: "The file is no longer where Claude saved it.",
  "not-ended": "The result shows here once the workflow ends.",
  "too-large": "The file is too large to show here.",
  unreadable: "The file could not be read.",
};

function Note({ children }: { readonly children: string }) {
  return <p className="px-3 py-6 text-[12px] text-muted-foreground">{children}</p>;
}

export function WorkflowRunFileView({
  environmentId,
  threadId,
  run,
  file,
  cwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: OrchestrationWorkflowRun;
  readonly file: WorkflowRunFileKind;
  readonly cwd: string | undefined;
}) {
  const state = useWorkflowRunFile({
    environmentId,
    threadId,
    taskId: run.taskId,
    file,
    // A script never changes; a result appears when the run ends.
    revision: file === "result" ? run.status : "script",
  });
  if (file === "result" && run.status === "running") {
    return <Note>{UNAVAILABLE_WORDS["not-ended"]!}</Note>;
  }
  if (state.status === "loading") return <Note>Loading…</Note>;
  if (state.status === "error") return <Note>{state.message}</Note>;
  const loaded = state.file;
  if (loaded.text === null) {
    return <Note>{UNAVAILABLE_WORDS[loaded.unavailableReason ?? "unreadable"]!}</Note>;
  }
  return (
    <div className="min-w-0 px-3 py-3" data-workflow-run-file={file}>
      {loaded.logs && loaded.logs.length > 0 ? (
        <div className="mb-3">
          <div className="pb-1 text-[11.5px] font-semibold text-muted-foreground">Log</div>
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {loaded.logs.map((line, index) => (
              <li key={`${index}:${line.slice(0, 24)}`} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {loaded.format === "markdown" ? (
        <div className="text-[13px]">
          <ChatMarkdown
            text={loaded.text}
            cwd={cwd}
            environmentId={environmentId}
            threadId={threadId}
          />
        </div>
      ) : (
        <pre className="overflow-x-auto rounded-md bg-foreground/[0.04] p-3 font-mono text-[11.5px] leading-[1.55] text-foreground/90">
          {loaded.text}
        </pre>
      )}
      {loaded.truncated ? (
        <p className="mt-2 text-[11.5px] text-muted-foreground">Cut short: the file is long.</p>
      ) : null}
    </div>
  );
}
