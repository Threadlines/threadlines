/**
 * A theme an agent offered with `show_theme` (docs/design/custom-themes.md,
 * "What the user sees"): a page of kind "theme" whose stored version is the
 * theme file. The chat shows it as a row with a picture of the theme, its
 * name, what it is, and Try it, which starts the theme's trial.
 */
import type {
  EnvironmentId,
  OrchestrationAgentPage,
  ThemeManifest,
  ThreadId,
} from "@threadlines/contracts";
import { checkThemeManifest, themeContentHash } from "@threadlines/shared/themeManifest";
import { PaletteIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { startThemeTrial, useActiveTheme, useThemeTrial } from "~/theme/themeStore";
import { describeTheme } from "~/themeLibrary/themeCatalog";
import { readAgentPageContent } from "../../chat/agentPageClient";
import { Button } from "../../ui/button";

type Loaded =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly manifest: ThemeManifest; readonly hash: string }
  | { readonly state: "failed"; readonly reason: string };

const LOADING: Loaded = { state: "loading" };

export function ThemeOfferRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly page: OrchestrationAgentPage;
  readonly updated: boolean;
}) {
  const { page } = props;
  // What was read, for the version it was read for: a newer version shows loading until it's in.
  const [read, setRead] = useState<{ readonly versionId: string; readonly loaded: Loaded } | null>(
    null,
  );
  const loaded = read?.versionId === page.versionId ? read.loaded : LOADING;
  const active = useActiveTheme();
  const trial = useThemeTrial();

  useEffect(() => {
    let cancelled = false;
    const versionId = page.versionId;
    const setLoaded = (next: Loaded) => setRead({ versionId, loaded: next });
    void readAgentPageContent({
      environmentId: props.environmentId,
      threadId: props.threadId,
      pageId: page.pageId,
      versionId: page.versionId,
    })
      .then(async (result) => {
        const check = checkThemeManifest(JSON.parse(result.content));
        if (!check.ok) throw new Error(check.errors[0] ?? "This theme doesn't check out.");
        const hash = await themeContentHash(check.manifest);
        if (!cancelled) setLoaded({ state: "ready", manifest: check.manifest, hash });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoaded({
            state: "failed",
            reason: error instanceof Error ? error.message : "The theme couldn't be read.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [page.pageId, page.versionId, props.environmentId, props.threadId]);

  const manifest = loaded.state === "ready" ? loaded.manifest : null;
  const showing = loaded.state === "ready" && active.hash === loaded.hash;
  const trying = showing && trial !== null;
  const still = manifest?.backdrop?.still ?? null;
  return (
    <div
      className="flex min-w-0 items-center gap-3 surface-group px-3 py-2.5"
      data-agent-page-row={page.pageId}
      data-theme-offer
    >
      <div className="aspect-[5/3] w-[88px] shrink-0 overflow-hidden rounded-[var(--app-radius-surface)] ring-1 ring-border">
        {still ? (
          <img src={still} alt="" className="size-full object-cover" draggable={false} />
        ) : manifest ? (
          <div
            className="flex size-full items-end justify-end p-1.5"
            style={{ background: manifest.colors.background }}
          >
            <div className="size-2.5 rounded-full" style={{ background: manifest.colors.accent }} />
          </div>
        ) : (
          <div className="grid size-full place-items-center text-muted-foreground">
            <PaletteIcon className="size-4" aria-hidden />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13.5px] leading-5 font-medium text-foreground">
            {manifest?.name ?? page.title}
          </span>
          {props.updated ? (
            <span className="shrink-0 text-[12.5px] text-muted-foreground">Updated</span>
          ) : null}
        </div>
        <div className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
          {loaded.state === "failed"
            ? loaded.reason
            : manifest
              ? describeTheme({ base: manifest.base, hasArt: manifest.backdrop !== undefined })
              : "Theme"}
        </div>
      </div>
      {manifest && loaded.state === "ready" ? (
        <Button
          size="sm"
          variant={showing ? "outline" : "default"}
          disabled={showing}
          onClick={() =>
            startThemeTrial({
              choice: { kind: "unsaved", hash: loaded.hash, name: manifest.name },
              manifest,
            })
          }
        >
          {trying ? "Trying" : showing ? "In use" : "Try it"}
        </Button>
      ) : null}
    </div>
  );
}
