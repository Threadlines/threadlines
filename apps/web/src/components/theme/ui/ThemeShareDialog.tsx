/**
 * Share to Showcase (docs/design/custom-themes.md, "Showcase"): a theme from
 * the library goes to the public Threadlines/themes repository as a pull
 * request from the person's own GitHub account, on the computer that holds
 * it. The dialog shows what gets published (the picture, the credit, the
 * fonts and their licenses) and why it can't be yet, before anything is sent,
 * and says in two short lines what sharing does: it's public at once, under
 * which account, and it's the person's own work. Kept light on purpose:
 * sharing a theme should feel friendly, not like signing something. A share
 * keeps its id while the dialog is open, so sending again after an unclear
 * failure picks the same share up instead of opening another.
 *
 * Take back (ThemeTakeBackDialog) is the quiet way out until a theme is
 * added: in the theme's menu, never advertised here.
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
import { cn } from "~/lib/utils";
import { describeTheme } from "~/themeLibrary/themeCatalog";
import {
  newShowcaseSubmissionId,
  prepareShowcaseShare,
  readShowcaseAccount,
  submitShowcaseShare,
  takeBackShowcaseShare,
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
import { toastManager } from "../../ui/toast";
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
  keepsEmailPrivate,
  onCheck,
}: {
  readonly account: Account;
  readonly environmentId: EnvironmentId;
  readonly keepsEmailPrivate: boolean;
  readonly onCheck: () => void;
}) {
  const line = "text-[12.5px] leading-[18px] text-muted-foreground";
  switch (account.status) {
    case "checking":
      return <p className={line}>Checking GitHub…</p>;
    case "signedIn":
      return (
        <div className={cn("grid gap-1.5", line)} data-testid="theme-share-terms">
          <p>
            Shared from <span className="font-medium text-foreground">@{account.login}</span> on
            GitHub, where it's public right away.
            {keepsEmailPrivate
              ? null
              : " An older Threadlines on that computer also shows your GitHub email there. Update it first to keep the email private."}
          </p>
          <p>
            By sharing, you're saying it's your own work, with nothing copied from a game, film or
            brand.
          </p>
        </div>
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
  keepsEmailPrivate,
  entryId,
  name,
  manifest,
  onClose,
}: {
  /** A computer holding the theme whose server shares (`themeShowcase`). */
  readonly environmentId: EnvironmentId;
  /**
   * That server leaves the account's email out of the share
   * (`themeShowcaseTakeBack`). An older one publishes it, and the dialog says so.
   */
  readonly keepsEmailPrivate: boolean;
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
          <AccountLine
            account={account}
            environmentId={environmentId}
            keepsEmailPrivate={keepsEmailPrivate}
            onCheck={check}
          />
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

/**
 * Take back: closes a share's pull request before it's added, from the
 * computer and GitHub account that shared it. Says, briefly, that the closed
 * pull request stays on GitHub, and puts the pull request a click away when
 * GitHub won't close it.
 */
export function ThemeTakeBackDialog({
  environmentId,
  submission,
  name,
  onClose,
}: {
  /** The computer that made the share. */
  readonly environmentId: EnvironmentId;
  readonly submission: ThemeShowcaseSubmission;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const [taking, setTaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takeBack = () => {
    setTaking(true);
    setError(null);
    void takeBackShowcaseShare(environmentId, submission.submissionId)
      .then((taken) => {
        // A maintainer may have closed it first: then it wasn't taken back, and the tile says so.
        toastManager.add(
          taken.takenBack === true
            ? { type: "success", title: `${name} was taken back from the Showcase` }
            : { type: "info", title: `${name}'s pull request was already closed` },
        );
        onClose();
      })
      .catch((cause: unknown) => {
        setTaking(false);
        setError(
          isShowcaseError(cause)
            ? cause.detail
            : messageOf(cause, "Couldn't take the theme back. Try again."),
        );
      });
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md" data-testid="theme-take-back-dialog">
        <DialogHeader>
          <DialogTitle>Take {name} back?</DialogTitle>
          <DialogDescription>
            It won't be added to the Showcase, and you can share it again any time. Its closed pull
            request stays on GitHub.
          </DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <DialogPanel>
            <p role="alert" className="text-[12.5px] whitespace-pre-line text-warning">
              {error}
            </p>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          {error !== null ? (
            <Button variant="outline" onClick={() => openExternalUrl(submission.pullRequestUrl)}>
              Open pull request
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={taking} onClick={takeBack}>
            {taking ? <Spinner className="size-3.5" /> : null}
            Take back
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
