/**
 * The "Report a problem" form (ReportProblemDialog.tsx opens it). The report
 * is posted from the person's own GitHub account through the computer's
 * GitHub sign-in, so GitHub tells them when someone replies. Signed out, they
 * can sign in here or finish on GitHub's form, which opens with what they
 * wrote. The report being written is kept when the dialog closes, until it's
 * posted or carried to GitHub.
 */
import {
  type EnvironmentId,
  REPORT_PROBLEM_LIMITS,
  type ReportProblemAccount,
  ReportProblemError,
  type ReportProblemResult,
} from "@threadlines/contracts";
import {
  buildReportIssueBody,
  buildReportIssueUrl,
  REPORT_ISSUE_URL_MAX_LENGTH,
  type ReportIssueDraft,
} from "@threadlines/shared/reportIssue";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { copyTextToClipboard } from "../lib/clipboard";
import { openExternalUrl } from "../lib/externalLinks";
import { defaultReportSetup, REPORT_ISSUE_VERSION } from "../lib/reportIssue";
import { readSourceControlServer, useSourceControlSetup } from "../lib/sourceControlDiscoveryState";
import { randomUUID } from "../lib/utils";
import {
  isRetryableRequestFailure,
  TransportRequestRetriesExhaustedError,
} from "../rpc/transportError";
import { GitHubSignInAction } from "./settings/GitHubSignInAction";
import { Button } from "./ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { LabeledField } from "./ui/labeled-field";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";

interface ReportDraft extends ReportIssueDraft {
  readonly setup: string;
  /** One per report, kept across tries, so a retry can't post it twice. */
  readonly submissionId: string;
}

function freshDraft(): ReportDraft {
  return {
    title: "",
    whatHappened: "",
    steps: "",
    expected: "",
    errorText: "",
    setup: defaultReportSetup(),
    submissionId: randomUUID(),
  };
}

type AccountState =
  | { readonly status: "checking" }
  /** No computer to post from, as on a phone that lost its pairing. */
  | { readonly status: "noServer" }
  | ReportProblemAccount;

type ReportStatus =
  | {
      readonly kind: "editing";
      readonly error: string | null;
      readonly note: string | null;
      /** GitHub may already have it: the text stays as sent until a retry settles it. */
      readonly uncertain: boolean;
    }
  | { readonly kind: "posting" }
  | { readonly kind: "posted"; readonly issue: ReportProblemResult };

const EDITING: ReportStatus = { kind: "editing", error: null, note: null, uncertain: false };

/**
 * The report being written and where its post stands. Both outlive the
 * dialog, so closing it mid-post loses nothing, and the fields stay locked
 * until GitHub's answer arrives.
 */
const useReportStore = create<{ readonly draft: ReportDraft; readonly status: ReportStatus }>(
  () => ({ draft: freshDraft(), status: EDITING }),
);

/** Puts away a "Posted" receipt as the dialog closes, so the next opening starts a new report. */
export function dismissReportReceipt(): void {
  if (useReportStore.getState().status.kind === "posted") setReportStatus(EDITING);
}

export function resetReportProblemForTests(): void {
  useReportStore.setState({ draft: freshDraft(), status: EDITING });
}

function setReportStatus(status: ReportStatus): void {
  useReportStore.setState({ status });
}

const isReportProblemError = Schema.is(ReportProblemError);

/**
 * Why a post failed, and whether GitHub may have the report anyway: when the
 * server says so, or when the answer was lost on the way back from it.
 */
function describePostFailure(cause: unknown): {
  readonly error: string;
  readonly uncertain: boolean;
} {
  if (isReportProblemError(cause)) return { error: cause.reason, uncertain: cause.uncertain };
  if (isRetryableRequestFailure(cause) || cause instanceof TransportRequestRetriesExhaustedError) {
    return {
      error:
        "The connection dropped before Threadlines answered, so the report may have posted. Posting again checks for it first.",
      uncertain: true,
    };
  }
  return {
    error: cause instanceof Error ? cause.message : "Couldn't post the report.",
    uncertain: false,
  };
}

export function ReportProblemDialogContent({
  errorText,
  onClose,
}: {
  readonly errorText?: string;
  readonly onClose: () => void;
}) {
  const draft = useReportStore((state) => state.draft);
  const status = useReportStore((state) => state.status);
  // The computer the report posts from, fixed while the dialog is open.
  const [environmentId] = useState<EnvironmentId | null>(
    () => readPrimaryEnvironmentDescriptor()?.environmentId ?? null,
  );
  const { githubAuth } = useSourceControlSetup({ environmentId });
  const [account, setAccount] = useState<AccountState>({ status: "checking" });
  const latestCheck = useRef(0);

  // A report that's posting or may have posted keeps its text as sent.
  useEffect(() => {
    if (!errorText) return;
    const { draft: current, status: currentStatus } = useReportStore.getState();
    const unlocked =
      currentStatus.kind === "posted" ||
      (currentStatus.kind === "editing" && !currentStatus.uncertain);
    if (unlocked && current.errorText.trim().length === 0) {
      useReportStore.setState({ draft: { ...current, errorText } });
    }
  }, [errorText]);

  /**
   * Asks the computer who would post. The answer replaces what's on screen
   * when it arrives, unless a newer question was asked meanwhile.
   */
  const requestAccount = useCallback(() => {
    const check = ++latestCheck.current;
    const server = readSourceControlServer({ environmentId });
    const answer: Promise<AccountState> = server
      ? server.getReportProblemAccount().catch(() => ({
          status: "unavailable",
          reason: "Couldn't check GitHub on this computer.",
        }))
      : Promise.resolve({ status: "noServer" });
    void answer.then((next) => {
      if (check === latestCheck.current) setAccount(next);
    });
  }, [environmentId]);

  useEffect(() => {
    requestAccount();
    return () => {
      latestCheck.current += 1;
    };
  }, [requestAccount]);

  // A sign-in that finishes, here or in Settings, changes who would post.
  const authStatus = githubAuth.status;
  const previousAuthStatus = useRef(authStatus);
  useEffect(() => {
    if (previousAuthStatus.current === authStatus) return;
    previousAuthStatus.current = authStatus;
    if (authStatus === "succeeded") requestAccount();
  }, [authStatus, requestAccount]);

  const posting = status.kind === "posting";
  const locked = posting || (status.kind === "editing" && status.uncertain);

  const update = (patch: Partial<ReportDraft>) => {
    if (locked) return;
    useReportStore.setState((state) => ({ draft: { ...state.draft, ...patch }, status: EDITING }));
  };

  const missingRequired = [draft.title, draft.whatHappened, draft.steps, draft.setup].some(
    (value) => value.trim().length === 0,
  );

  const post = async () => {
    if (account.status !== "signedIn" || missingRequired || posting) return;
    const server = readSourceControlServer({ environmentId });
    if (!server) {
      setAccount({ status: "noServer" });
      return;
    }
    // Once GitHub may have it, the text stays locked until a post succeeds.
    const wasUncertain = status.kind === "editing" && status.uncertain;
    setReportStatus({ kind: "posting" });
    try {
      const issue = await server.reportProblem({
        submissionId: draft.submissionId,
        login: account.login,
        title: draft.title,
        whatHappened: draft.whatHappened,
        steps: draft.steps,
        expected: draft.expected,
        errorText: draft.errorText,
        version: REPORT_ISSUE_VERSION,
        setup: draft.setup,
      });
      useReportStore.setState({ draft: freshDraft(), status: { kind: "posted", issue } });
    } catch (cause) {
      const failure = describePostFailure(cause);
      setReportStatus({
        kind: "editing",
        note: null,
        error: failure.error,
        uncertain: failure.uncertain || wasUncertain,
      });
      requestAccount();
    }
  };

  const finishOnGitHub = async () => {
    const version = REPORT_ISSUE_VERSION;
    const withDraft = buildReportIssueUrl({ version, setup: draft.setup, draft });
    if (withDraft.length <= REPORT_ISSUE_URL_MAX_LENGTH) {
      openExternalUrl(withDraft);
      useReportStore.setState({ draft: freshDraft(), status: EDITING });
      onClose();
      return;
    }
    // Too long for a link: carry the title, and put the rest on the clipboard.
    const copied = await copyTextToClipboard(
      buildReportIssueBody({ draft, version, setup: draft.setup }),
    ).then(
      () => true,
      () => false,
    );
    openExternalUrl(
      buildReportIssueUrl({
        version,
        setup: draft.setup,
        draft: { title: draft.title, whatHappened: "", steps: "", expected: "", errorText: "" },
      }),
    );
    const note = copied
      ? "Your report is too long to carry over, so it's copied. Paste it into the form on GitHub."
      : "Your report is too long to carry over. Copy it from here into the form on GitHub.";
    // A post started while the clipboard was busy keeps its status.
    useReportStore.setState((state) =>
      state.status.kind === "editing" ? { status: { ...state.status, error: null, note } } : state,
    );
  };

  if (status.kind === "posted") {
    return (
      <DialogPopup className="max-w-xl" data-testid="report-problem-dialog">
        <DialogHeader>
          <DialogTitle>Posted as issue #{status.issue.number}</DialogTitle>
          <DialogDescription>
            Thanks for reporting it. We'll reply on the issue, and GitHub will let you know. To add
            screenshots, open the issue and drop them into a comment.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
          <Button onClick={() => openExternalUrl(status.issue.url)}>Open issue</Button>
        </DialogFooter>
      </DialogPopup>
    );
  }

  const canPost = account.status === "signedIn";

  return (
    <DialogPopup className="max-w-xl" data-testid="report-problem-dialog">
      <DialogHeader>
        <DialogTitle>Report a problem</DialogTitle>
        <DialogDescription>
          Reports go on our public GitHub page, so leave out private project names, file paths and
          keys.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-4">
        <LabeledField label="Summary">
          <Input
            nativeInput
            size="sm"
            value={draft.title}
            maxLength={REPORT_PROBLEM_LIMITS.title}
            placeholder="Changing the access level opens a different chat"
            disabled={locked}
            onChange={(event) => update({ title: event.target.value })}
          />
        </LabeledField>
        <LabeledField label="What happened?">
          <Textarea
            size="sm"
            value={draft.whatHappened}
            maxLength={REPORT_PROBLEM_LIMITS.text}
            disabled={locked}
            onChange={(event) => update({ whatHappened: event.target.value })}
          />
        </LabeledField>
        <LabeledField
          label="How can we make it happen?"
          hint="Rough steps are fine. If it only happened once, say that."
        >
          <Textarea
            size="sm"
            value={draft.steps}
            maxLength={REPORT_PROBLEM_LIMITS.text}
            placeholder={
              "1. Open a chat and type a message without sending it\n2. Change the access level"
            }
            disabled={locked}
            onChange={(event) => update({ steps: event.target.value })}
          />
        </LabeledField>
        <LabeledField label="What did you expect instead?" optional>
          <Textarea
            size="sm"
            value={draft.expected}
            maxLength={REPORT_PROBLEM_LIMITS.text}
            disabled={locked}
            onChange={(event) => update({ expected: event.target.value })}
          />
        </LabeledField>
        <LabeledField
          label="Error text"
          optional
          hint="Paste only the part that matters, and check it for anything private."
        >
          <Textarea
            size="sm"
            className="font-mono text-xs sm:text-xs"
            value={draft.errorText}
            maxLength={REPORT_PROBLEM_LIMITS.errorText}
            disabled={locked}
            onChange={(event) => update({ errorText: event.target.value })}
          />
        </LabeledField>
        <LabeledField
          label="Your setup"
          hint={`Version ${REPORT_ISSUE_VERSION} is added for you. Name the agent if it matters.`}
        >
          <Input
            nativeInput
            size="sm"
            value={draft.setup}
            maxLength={REPORT_PROBLEM_LIMITS.setup}
            disabled={locked}
            onChange={(event) => update({ setup: event.target.value })}
          />
        </LabeledField>
        {status.kind === "editing" && status.error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {status.error}
          </p>
        ) : null}
        {status.kind === "editing" && status.note ? (
          <p role="status" className="text-xs text-muted-foreground">
            {status.note}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter className="sm:items-center">
        <AccountLine
          account={account}
          environmentId={environmentId}
          onCheckAgain={() => {
            setAccount({ status: "checking" });
            requestAccount();
          }}
          onClose={onClose}
        />
        <Button
          variant={canPost ? "outline" : "default"}
          disabled={posting}
          onClick={() => void finishOnGitHub()}
        >
          Finish on GitHub
        </Button>
        {canPost ? (
          <Button disabled={posting || missingRequired} onClick={() => void post()}>
            {posting ? <Spinner /> : null}
            {posting ? "Posting…" : locked ? "Post again" : "Post report"}
          </Button>
        ) : null}
      </DialogFooter>
    </DialogPopup>
  );
}

/** Who the report would post as, or what posting from here still needs. */
function AccountLine({
  account,
  environmentId,
  onCheckAgain,
  onClose,
}: {
  readonly account: AccountState;
  readonly environmentId: EnvironmentId | null;
  readonly onCheckAgain: () => void;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  let content: ReactNode;
  switch (account.status) {
    case "checking":
      content = "Checking GitHub…";
      break;
    case "signedIn":
      content = (
        <span>
          Posting as <span className="font-medium text-foreground">@{account.login}</span>
        </span>
      );
      break;
    case "signedOut":
      content = (
        <>
          <span>Sign in to GitHub to post from here.</span>
          <GitHubSignInAction environmentId={environmentId} />
        </>
      );
      break;
    case "noGitHubCli":
      content = (
        <>
          <span>Posting from here needs the GitHub tool.</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              onClose();
              void navigate({ to: "/settings/source-control" });
            }}
          >
            Set it up
          </Button>
        </>
      );
      break;
    case "unavailable":
      content = (
        <>
          <span>{account.reason}</span>
          <Button size="xs" variant="outline" onClick={onCheckAgain}>
            Check again
          </Button>
        </>
      );
      break;
    case "noServer":
      content = "Not connected to a computer, so this can only be finished on GitHub.";
      break;
  }
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:me-auto"
      data-testid="report-problem-account"
    >
      {content}
    </div>
  );
}
