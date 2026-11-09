/**
 * Share to Showcase (docs/design/custom-themes.md, "Showcase"): a theme from
 * the library goes to the public Threadlines/themes repository as a pull
 * request from the person's own GitHub account, on the computer that holds
 * it. The dialog shows what gets published (the picture, the credit, the
 * fonts and their licenses) and why it can't be yet, before anything is sent.
 * A share keeps its id while the dialog is open, so sending again after an
 * unclear failure picks the same share up instead of opening another.
 */
import {
  type EnvironmentId,
  type ReportProblemAccount,
  type ThemeManifest,
  ThemeShowcaseError,
  type ThemeShowcasePreparation,
  type ThemeShowcaseSubmission,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState } from "react";

import { openExternalUrl } from "~/lib/externalLinks";
import {
  isRetryableRequestFailure,
  TransportRequestRetriesExhaustedError,
} from "~/rpc/transportError";
import { useSourceControlSetup } from "~/lib/sourceControlDiscoveryState";
import { describeTheme } from "~/themeLibrary/themeCatalog";
import {
  newShowcaseSubmissionId,
  prepareShowcaseShare,
  readShowcaseAccount,
  submitShowcaseShare,
} from "~/themeLibrary/themeShowcase";
import { GitHubSignInAction } from "../../settings/GitHubSignInAction";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Spinner } from "../../ui/spinner";
import { useThemeCreditsDraft } from "./ThemeCreditsFields";
import { ThemePromptSwitch } from "./ThemePromptSwitch";

type Account =
  | ReportProblemAccount
  | { readonly status: "checking" }
  | { readonly status: "noServer" };

type Prepared =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly preparation: ThemeShowcasePreparation }
  | { readonly state: "failed"; readonly reason: string };

type Sending =
  | { readonly state: "idle"; readonly error: string | null; readonly uncertain: boolean }
  | { readonly state: "sending" }
  | { readonly state: "sent"; readonly submission: ThemeShowcaseSubmission };

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() !== "" ? cause.message : fallback;

const isShowcaseError = Schema.is(ThemeShowcaseError);

/** Why a share failed, and whether GitHub may have taken part of it (sending again checks). */
function describeShareFailure(cause: unknown): {
  readonly error: string;
  readonly uncertain: boolean;
} {
  if (isShowcaseError(cause)) return { error: cause.detail, uncertain: cause.uncertain === true };
  if (isRetryableRequestFailure(cause) || cause instanceof TransportRequestRetriesExhaustedError) {
    return {
      error:
        "The connection dropped before Threadlines answered, so the pull request may have opened. Sharing again checks for it first.",
      uncertain: true,
    };
  }
  return { error: messageOf(cause, "Couldn't share the theme. Try again."), uncertain: false };
}

function useGitHubAccount(environmentId: EnvironmentId) {
  const [account, setAccount] = useState<Account>({ status: "checking" });
  const latest = useRef(0);
  const check = useCallback(() => {
    const ask = ++latest.current;
    const answer: Promise<Account> = readShowcaseAccount(environmentId);
    void answer.then((next) => {
      if (ask === latest.current) setAccount(next);
    });
  }, [environmentId]);
  useEffect(() => {
    check();
    return () => {
      latest.current += 1;
    };
  }, [check]);
  // A sign-in that finishes here or in Settings changes who would share.
  const { githubAuth } = useSourceControlSetup({ environmentId });
  const previous = useRef(githubAuth.status);
  useEffect(() => {
    if (previous.current === githubAuth.status) return;
    previous.current = githubAuth.status;
    if (githubAuth.status === "succeeded") check();
  }, [githubAuth.status, check]);
  return { account, check };
}

function AccountLine({
  account,
  environmentId,
  onCheck,
}: {
  readonly account: Account;
  readonly environmentId: EnvironmentId;
  readonly onCheck: () => void;
}) {
  const line = "text-[12.5px] leading-[18px] text-muted-foreground";
  switch (account.status) {
    case "checking":
      return <p className={line}>Checking GitHub…</p>;
    case "signedIn":
      return (
        <p className={line}>
          Opens a public pull request from your GitHub account,{" "}
          <span className="font-medium text-foreground">@{account.login}</span>. Your account name
          shows with the theme once it's added.
        </p>
      );
    case "signedOut":
      return (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={line}>Sharing opens a pull request from your GitHub account.</p>
          <GitHubSignInAction environmentId={environmentId} />
        </div>
      );
    case "noGitHubCli":
      return (
        <p className={line}>
          Sharing needs the GitHub command-line tool (gh) on this computer. Install it, then{" "}
          <button
            type="button"
            className="font-medium text-primary-readable hover:underline"
            onClick={onCheck}
          >
            check again
          </button>
          .
        </p>
      );
    case "noServer":
      return <p className={line}>The computer with this theme isn't connected right now.</p>;
    default:
      return (
        <p className={line}>
          {account.reason}{" "}
          <button
            type="button"
            className="font-medium text-primary-readable hover:underline"
            onClick={onCheck}
          >
            Check again
          </button>
        </p>
      );
  }
}

export function ThemeShareDialog({
  environmentId,
  entryId,
  name,
  manifest,
  onClose,
}: {
  /** A computer holding the theme whose server shares (`themeShowcase`). */
  readonly environmentId: EnvironmentId;
  readonly entryId: string;
  readonly name: string;
  /** The theme as the library holds it, for its credits and prompt. */
  readonly manifest: ThemeManifest;
  readonly onClose: () => void;
}) {
  const credits = useThemeCreditsDraft(manifest, "It keeps its credit.");
  const [includePrompt, setIncludePrompt] = useState(false);
  const { account, check } = useGitHubAccount(environmentId);
  const [submissionId] = useState(newShowcaseSubmissionId);
  const [prepared, setPrepared] = useState<Prepared>({ state: "loading" });
  const [sending, setSending] = useState<Sending>({ state: "idle", error: null, uncertain: false });

  // What would be published: worked out again when the license or the prompt changes
  // (the picture is drawn once). The name and link only need to be well formed.
  const license = credits.own === null ? credits.license : null;
  const latest = useRef(0);
  useEffect(() => {
    const ask = ++latest.current;
    void prepareShowcaseShare(environmentId, {
      entryId,
      credits: license === null ? null : { license },
      includePrompt,
    })
      .then((preparation) => {
        if (ask === latest.current) setPrepared({ state: "ready", preparation });
      })
      .catch((cause: unknown) => {
        if (ask === latest.current) {
          setPrepared({
            state: "failed",
            reason: messageOf(cause, "Couldn't get the theme ready."),
          });
        }
      });
  }, [entryId, environmentId, includePrompt, license]);

  const preparation = prepared.state === "ready" ? prepared.preparation : null;
  const problems = preparation?.problems ?? [];
  const uncertain = sending.state === "idle" && sending.uncertain;
  const canShare =
    account.status === "signedIn" &&
    preparation !== null &&
    problems.length === 0 &&
    credits.valid &&
    sending.state === "idle";

  const share = () => {
    if (!canShare || account.status !== "signedIn") return;
    credits.remember();
    setSending({ state: "sending" });
    void submitShowcaseShare(environmentId, {
      entryId,
      credits: credits.own === null ? credits.given : null,
      includePrompt,
      submissionId,
      login: account.login,
    })
      .then((submission) => setSending({ state: "sent", submission }))
      .catch((cause: unknown) => {
        const failure = describeShareFailure(cause);
        setSending({
          state: "idle",
          error: failure.error,
          uncertain: failure.uncertain || uncertain,
        });
      });
  };

  if (sending.state === "sent") {
    return (
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogPopup className="max-w-md" data-testid="theme-share-dialog">
          <DialogHeader>
            <DialogTitle>Sent for review</DialogTitle>
            <DialogDescription>
              {name} goes into the Showcase once it's reviewed. Its tile here says how it's going.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => openExternalUrl(sending.submission.pullRequestUrl)}
            >
              Open pull request
            </Button>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md" data-testid="theme-share-dialog">
        <DialogHeader>
          <DialogTitle>Share {name} to the Showcase</DialogTitle>
          <DialogDescription>
            Anyone using Threadlines can try it once it's added. It never says which thread made it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="flex items-center gap-3">
            <div className="aspect-[8/5] w-28 shrink-0 overflow-hidden rounded-[var(--app-radius-surface)] ring-1 ring-border">
              {preparation?.thumbnail ? (
                <img
                  src={preparation.thumbnail}
                  alt=""
                  className="size-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="grid size-full place-items-center text-muted-foreground">
                  {prepared.state === "loading" ? <Spinner className="size-4" /> : null}
                </div>
              )}
            </div>
            <div className="min-w-0 text-[12.5px] leading-[18px]">
              <div className="truncate text-[13.5px] font-medium text-foreground">{name}</div>
              <div className="text-muted-foreground">
                {describeTheme({ base: manifest.base, hasArt: manifest.backdrop !== undefined })}
              </div>
              {preparation !== null && preparation.fonts.length > 0 ? (
                <div className="text-muted-foreground">
                  {preparation.fonts
                    .map(
                      (font) =>
                        `${font.family}${font.license ? ` (${font.license === "OFL-1.1" ? "OFL" : "Apache"})` : ""}`,
                    )
                    .join(", ")}
                </div>
              ) : null}
            </div>
          </div>
          {credits.fields}
          <ThemePromptSwitch
            prompt={manifest.prompt}
            checked={includePrompt}
            onCheckedChange={setIncludePrompt}
          />
          {prepared.state === "failed" ? (
            <p role="alert" className="text-[12.5px] text-warning">
              {prepared.reason}
            </p>
          ) : problems.length > 0 ? (
            <div role="alert" className="grid gap-1 text-[12.5px] leading-[18px] text-warning">
              <span className="font-medium">It can't be shared yet:</span>
              <ul className="list-disc ps-4">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <AccountLine account={account} environmentId={environmentId} onCheck={check} />
          {sending.state === "idle" && sending.error !== null ? (
            <p role="alert" className="text-[12.5px] whitespace-pre-line text-warning">
              {sending.error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canShare} onClick={share}>
            {sending.state === "sending" ? <Spinner className="size-3.5" /> : null}
            {uncertain ? "Check and share" : "Share"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
