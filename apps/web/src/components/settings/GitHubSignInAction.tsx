import type { EnvironmentId } from "@threadlines/contracts";
import { useEffect, useRef, useState } from "react";

import { openExternalUrl } from "../../lib/externalLinks";
import {
  cancelGitHubSignIn,
  startGitHubSignIn,
  useSourceControlSetup,
} from "../../lib/sourceControlDiscoveryState";
import { Button } from "../ui/button";

const GITHUB_DEVICE_URL = "https://github.com/login/device";

export function GitHubSignInStatus({
  environmentId,
}: {
  readonly environmentId?: EnvironmentId | null | undefined;
}) {
  const { githubAuth } = useSourceControlSetup({ environmentId });
  return githubAuth.status === "succeeded" && githubAuth.message ? (
    <span role="status" className="max-w-64 text-xs text-muted-foreground">
      {githubAuth.message}
    </span>
  ) : null;
}

export function GitHubSignInAction({
  environmentId,
}: {
  readonly environmentId?: EnvironmentId | null | undefined;
}) {
  const { githubAuth } = useSourceControlSetup({ environmentId });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openWhenReady = useRef(false);
  const running = pending || githubAuth.status === "running";
  const canOpen = githubAuth.verificationUrl === GITHUB_DEVICE_URL;

  useEffect(() => {
    if (openWhenReady.current && canOpen && githubAuth.userCode) {
      openWhenReady.current = false;
      openExternalUrl(GITHUB_DEVICE_URL);
    }
  }, [canOpen, githubAuth.userCode]);

  const start = () => {
    setPending(true);
    setError(null);
    openWhenReady.current = true;
    void startGitHubSignIn({ environmentId })
      .catch((cause: unknown) => {
        openWhenReady.current = false;
        setError(cause instanceof Error ? cause.message : "Could not start GitHub sign-in.");
      })
      .finally(() => setPending(false));
  };

  return (
    <div className="flex max-w-80 flex-wrap items-center justify-end gap-2 text-xs">
      {running ? (
        <>
          <span role="status" className="text-muted-foreground">
            {githubAuth.userCode ? (
              <>
                Enter code{" "}
                <code className="select-all font-mono text-foreground">{githubAuth.userCode}</code>{" "}
                on GitHub.
              </>
            ) : (
              "Starting GitHub sign-in…"
            )}
          </span>
          {canOpen ? (
            <Button size="xs" variant="outline" onClick={() => openExternalUrl(GITHUB_DEVICE_URL)}>
              Open GitHub
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              openWhenReady.current = false;
              void cancelGitHubSignIn({ environmentId }).catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Could not cancel sign-in."),
              );
            }}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button size="xs" variant="outline" onClick={start} aria-label="Sign in to GitHub">
          {githubAuth.status === "failed" ? "Retry sign-in" : "Sign in"}
        </Button>
      )}
      {error || githubAuth.status === "failed" ? (
        <span role="alert" className="w-full text-warning">
          {error ?? githubAuth.message}
        </span>
      ) : null}
    </div>
  );
}
