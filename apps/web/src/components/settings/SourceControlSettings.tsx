import { GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { Fragment, type ReactNode } from "react";
import type { SettingsPlaceId } from "@threadlines/shared/appPlaces";
import type {
  EnvironmentId,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@threadlines/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type SourceControlWritingStyleMode,
} from "@threadlines/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  resolveAppModelSelectionState,
  resolveSourceControlWriterModelSelectionState,
} from "../../modelSelection";
import { useServerProviders } from "../../rpc/serverState";
import { cn } from "../../lib/utils";
import {
  refreshSourceControlDiscovery,
  useSourceControlDiscovery,
  useSourceControlSetup,
} from "../../lib/sourceControlDiscoveryState";
import { useStore } from "../../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { DraftTextarea } from "../ui/draft-textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  TextGenerationModelControl,
  textGenerationInstanceEntries,
} from "./TextGenerationModelControl";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  JujutsuIcon,
  type Icon,
} from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import {
  SETTINGS_GROUP_ROW_CLASS,
  SettingResetButton,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { CompactVersionAdvisory, SourceControlToolProgress } from "./CompactVersionAdvisory";
import { GitHubSignInAction, GitHubSignInStatus } from "./GitHubSignInAction";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
const GIT_FETCH_INTERVAL_STEP_SECONDS = 5;

function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

function normalizeFetchIntervalSeconds(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: string;
  readonly badge: "warning" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "Authenticated", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "Not authenticated", badge: "warning" };
  }
  return { label: "Status unknown", badge: null };
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (item.status !== "available") return "bg-warning";
  if (isProviderDiscoveryItem(item) && item.auth.status !== "authenticated") return "bg-warning";
  return "bg-success";
}

function itemReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  if (item.status !== "available") return false;
  if (isProviderDiscoveryItem(item)) return item.auth.status === "authenticated";
  return item.implemented;
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const Icon = isProviderDiscoveryItem(item)
    ? SOURCE_CONTROL_PROVIDER_ICONS[item.kind]
    : VCS_ICONS[item.kind];

  if (!Icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <Icon className="size-4.5 text-foreground/80" aria-hidden />
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          dotClassName,
        )}
        aria-hidden
      />
    </span>
  );
}

function itemSummary({
  item,
  auth,
  authAccount,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  if (isVcsNotReady(item)) {
    return <span>Support for {item.label} is coming soon.</span>;
  }

  if (item.status !== "available") {
    return <span>Not available on this server: {item.installHint}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      return (
        <>
          <span>Authenticated</span>
          {authAccount ? (
            <>
              <span aria-hidden>as</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
        </>
      );
    }

    if (!item.executable) {
      return <span>{item.installHint}</span>;
    }

    if (auth.status === "unauthenticated") {
      if (item.kind === "github")
        return <span>Sign in to browse your repositories and use pull requests.</span>;
      return (
        <span>
          {item.label} is not authenticated on this server. Sign in or configure credentials using
          the <code className="rounded bg-muted px-1 py-px text-[11px]">{item.executable}</code>{" "}
          tool on the server host to enable pull request features.
        </span>
      );
    }
    return (
      <span>
        Could not verify {item.label}. {item.installHint}
      </span>
    );
  }

  return <span>Available</span>;
}

function DiscoveryItemRow({
  item,
  environmentId,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly environmentId?: EnvironmentId | null;
}) {
  const version = optionLabel(item.version);
  const isReady = itemReady(item);
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authStatus = auth ? authPresentation(auth) : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  return (
    <div className={cn(SETTINGS_GROUP_ROW_CLASS, isVcsNotReady(item) && "opacity-80")}>
      <div className="px-3.5 py-2.5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <span className="truncate text-[13.5px] font-medium text-foreground">
                {item.label}
              </span>
              {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
              {item.versionAdvisory && item.versionAdvisory.actions.length > 0 ? (
                <CompactVersionAdvisory
                  advisory={item.versionAdvisory}
                  environmentId={environmentId}
                  label={item.label}
                />
              ) : item.kind === "git" || item.kind === "github" ? (
                <SourceControlToolProgress
                  target={item.kind === "git" ? "git" : "github-cli"}
                  environmentId={environmentId}
                />
              ) : null}
              {isVcsNotReady(item) ? (
                <Badge variant="warning" size="sm">
                  Coming soon
                </Badge>
              ) : null}
              {authStatus?.badge ? (
                <Badge variant={authStatus.badge} size="sm">
                  {authStatus.label}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[12.5px] text-muted-foreground">
              {itemSummary({ item, auth, authAccount })}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {isProviderDiscoveryItem(item) &&
            item.kind === "github" &&
            item.auth.status === "authenticated" ? (
              <GitHubSignInStatus environmentId={environmentId} />
            ) : null}
            {isProviderDiscoveryItem(item) &&
            item.kind === "github" &&
            item.status === "available" &&
            item.auth.status !== "authenticated" ? (
              <GitHubSignInAction key={environmentId ?? "primary"} environmentId={environmentId} />
            ) : null}
            {!isVcsNotReady(item) ? (
              <Switch checked={isReady} disabled aria-label={`${item.label} availability`} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * How often Git checks remote branches in the background (Settings › Source
 * Control › Version control), a row of its own under the Git it applies to.
 */
export function FetchIntervalRow() {
  const automaticGitFetchInterval = useSettings((settings) => settings.automaticGitFetchInterval);
  const { updateSettings } = useUpdateSettings();
  const automaticGitFetchIntervalSeconds = durationToSeconds(automaticGitFetchInterval);
  const defaultAutomaticGitFetchIntervalSeconds = durationToSeconds(
    DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
  );

  return (
    <SettingsRow
      place="sourceControl.fetchInterval"
      resetAction={
        automaticGitFetchIntervalSeconds !== defaultAutomaticGitFetchIntervalSeconds ? (
          <SettingResetButton
            label="fetch interval"
            onClick={() =>
              updateSettings({
                automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
              })
            }
          />
        ) : null
      }
      control={
        <>
          <NumberField
            value={automaticGitFetchIntervalSeconds}
            min={0}
            step={GIT_FETCH_INTERVAL_STEP_SECONDS}
            size="sm"
            className="w-32"
            onValueChange={(value) =>
              updateSettings({
                automaticGitFetchInterval: Duration.seconds(normalizeFetchIntervalSeconds(value)),
              })
            }
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease fetch interval" />
              <NumberFieldInput aria-label="Automatic Git fetch interval in seconds" />
              <NumberFieldIncrement aria-label="Increase fetch interval" />
            </NumberFieldGroup>
          </NumberField>
          <span className="text-xs text-muted-foreground">seconds</span>
        </>
      }
    />
  );
}

function SourceControlPanelSection() {
  return (
    <SettingsSection place="sourceControl.panel">
      <OpenPanelByDefaultRow />
    </SettingsSection>
  );
}

export function OpenPanelByDefaultRow() {
  const sourceControlPanelDefaultOpen = useSettings(
    (settings) => settings.sourceControlPanelDefaultOpen,
  );
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsRow
      place="sourceControl.openPanelByDefault"
      resetAction={
        sourceControlPanelDefaultOpen !== DEFAULT_UNIFIED_SETTINGS.sourceControlPanelDefaultOpen ? (
          <SettingResetButton
            label="open panel by default"
            onClick={() =>
              updateSettings({
                sourceControlPanelDefaultOpen:
                  DEFAULT_UNIFIED_SETTINGS.sourceControlPanelDefaultOpen,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={sourceControlPanelDefaultOpen}
          onCheckedChange={(checked) =>
            updateSettings({ sourceControlPanelDefaultOpen: Boolean(checked) })
          }
          aria-label="Open source control panel by default"
        />
      }
    />
  );
}

const WRITING_STYLE_OPTIONS: ReadonlyArray<{
  readonly value: SourceControlWritingStyleMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "repo_conventions",
    label: "Repository conventions",
    description:
      "In each project, matches the style of recent commit messages and merged pull requests.",
  },
  {
    value: "conventional_commits",
    label: "Conventional Commits",
    description:
      "Uses Conventional Commit prefixes for commit messages; PR titles and descriptions stay concise.",
  },
  {
    value: "custom",
    label: "Custom instructions",
    description:
      "Applies your instructions to commit messages, PR titles, and PR descriptions in every project.",
  },
];

function isWritingStyleMode(value: string): value is SourceControlWritingStyleMode {
  return WRITING_STYLE_OPTIONS.some((option) => option.value === value);
}

function TextGenerationSection() {
  return (
    <SettingsSection place="sourceControl.textGeneration">
      <WritingStyleRow />
      <FollowPrTemplatesRow />
      <WriterModelRow />
    </SettingsSection>
  );
}

function useWritingStyle() {
  const writingStyle = useSettings((settings) => settings.sourceControlWritingStyle);
  const { updateSettings } = useUpdateSettings();
  return {
    writingStyle,
    defaultWritingStyle: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
    updateSettings,
  };
}

export function WritingStyleRow() {
  const { writingStyle, defaultWritingStyle, updateSettings } = useWritingStyle();
  const selectedStyleOption =
    WRITING_STYLE_OPTIONS.find((option) => option.value === writingStyle.mode) ??
    WRITING_STYLE_OPTIONS[0];
  const isStyleDirty =
    writingStyle.mode !== defaultWritingStyle.mode ||
    writingStyle.customInstructions !== defaultWritingStyle.customInstructions;
  return (
    <SettingsRow
      place="sourceControl.writingStyle"
      description={selectedStyleOption?.description ?? ""}
      resetAction={
        isStyleDirty ? (
          <SettingResetButton
            label="source control writing style"
            onClick={() =>
              updateSettings({
                sourceControlWritingStyle: {
                  ...writingStyle,
                  mode: defaultWritingStyle.mode,
                  customInstructions: defaultWritingStyle.customInstructions,
                },
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={writingStyle.mode}
          onValueChange={(value) => {
            if (typeof value === "string" && isWritingStyleMode(value)) {
              updateSettings({ sourceControlWritingStyle: { ...writingStyle, mode: value } });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-56" aria-label="Source control writing style">
            <SelectValue>{selectedStyleOption?.label ?? ""}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WRITING_STYLE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    >
      {writingStyle.mode === "custom" ? (
        <div className="pb-3.5 pt-3">
          <DraftTextarea
            rows={4}
            value={writingStyle.customInstructions}
            placeholder="Keep titles concise. Use short bullet points in descriptions."
            aria-label="Custom source control writing instructions"
            onCommit={(next) =>
              updateSettings({
                sourceControlWritingStyle: { ...writingStyle, customInstructions: next },
              })
            }
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function FollowPrTemplatesRow() {
  const { writingStyle, defaultWritingStyle, updateSettings } = useWritingStyle();
  return (
    <SettingsRow
      place="sourceControl.followPrTemplates"
      resetAction={
        writingStyle.followPrTemplates !== defaultWritingStyle.followPrTemplates ? (
          <SettingResetButton
            label="follow PR templates"
            onClick={() =>
              updateSettings({
                sourceControlWritingStyle: {
                  ...writingStyle,
                  followPrTemplates: defaultWritingStyle.followPrTemplates,
                },
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={writingStyle.followPrTemplates}
          onCheckedChange={(checked) =>
            updateSettings({
              sourceControlWritingStyle: {
                ...writingStyle,
                followPrTemplates: Boolean(checked),
              },
            })
          }
          aria-label="Follow repository pull request templates"
        />
      }
    />
  );
}

export function WriterModelRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const primarySelection = resolveAppModelSelectionState(settings, serverProviders);
  const writerSelection = resolveSourceControlWriterModelSelectionState(settings, serverProviders);
  const instanceEntries = textGenerationInstanceEntries(serverProviders);
  return (
    <SettingsRow
      place="sourceControl.writerModel"
      control={
        <>
          {writerSelection ? (
            <TextGenerationModelControl
              selection={writerSelection}
              settings={settings}
              serverProviders={serverProviders}
              instanceEntries={instanceEntries}
              onSelectionChange={(nextSelection) => {
                updateSettings({
                  sourceControlWriterModelSelection: resolveAppModelSelectionState(
                    { ...settings, textGenerationModelSelection: nextSelection },
                    serverProviders,
                  ),
                });
              }}
            />
          ) : null}
          <Switch
            checked={writerSelection !== null}
            onCheckedChange={(checked) =>
              updateSettings({
                sourceControlWriterModelSelection: checked ? primarySelection : null,
              })
            }
            aria-label="Use a dedicated source control writer model"
          />
        </>
      }
    />
  );
}

function SourceControlSectionSkeleton({
  place,
  headerAction,
}: {
  readonly place: SettingsPlaceId;
  readonly headerAction?: ReactNode;
}) {
  return (
    <SettingsSection place={place} headerAction={headerAction}>
      {SOURCE_CONTROL_SKELETON_ROWS.map((row) => (
        <div key={row} className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-3")}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <Skeleton className="size-4.5 rounded-md" />
                  <Skeleton
                    className="pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background"
                    aria-hidden
                  />
                </span>
                <Skeleton className="h-4 w-28 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full max-w-xs rounded-full" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}

function EmptySourceControlDiscovery({
  error,
  isPending,
  onScan,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onScan: () => void;
}) {
  const hasError = error !== null;

  return (
    <SettingsSection title="Server environment">
      <Empty className="min-h-88">
        <EmptyMedia variant="icon">
          <GitPullRequestIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            {hasError ? "Could not scan the server environment" : "Nothing detected yet"}
          </EmptyTitle>
          <EmptyDescription>
            {hasError
              ? error
              : "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={onScan}
            disabled={isPending}
          >
            <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
            Scan
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  useSourceControlSetup({ environmentId: activeEnvironmentId });
  const discovery = useSourceControlDiscovery({ environmentId: activeEnvironmentId });
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const hasDiscoveryItems =
    result.versionControlSystems.length > 0 || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    void refreshSourceControlDiscovery({ environmentId: activeEnvironmentId });
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label="Rescan server environment"
          >
            <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      <SettingsPageHeader section="/settings/source-control" />
      <SourceControlPanelSection />
      {isInitialScanPending ? (
        <>
          <SourceControlSectionSkeleton
            place="sourceControl.versionControl"
            headerAction={scanButton}
          />
          <SourceControlSectionSkeleton place="sourceControl.providers" />
        </>
      ) : hasDiscoveryItems ? (
        <>
          {result.versionControlSystems.length > 0 ? (
            <SettingsSection place="sourceControl.versionControl" headerAction={scanButton}>
              {result.versionControlSystems.map((item) => (
                <Fragment key={`vcs:${item.kind}`}>
                  <DiscoveryItemRow item={item} environmentId={activeEnvironmentId} />
                  {/* Right under the Git it applies to. */}
                  {item.kind === "git" ? <FetchIntervalRow /> : null}
                </Fragment>
              ))}
            </SettingsSection>
          ) : null}

          {result.sourceControlProviders.length > 0 ? (
            <SettingsSection
              place="sourceControl.providers"
              headerAction={result.versionControlSystems.length === 0 ? scanButton : null}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow
                  key={`provider:${item.kind}`}
                  item={item}
                  environmentId={activeEnvironmentId}
                />
              ))}
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <EmptySourceControlDiscovery
          error={discovery.error}
          isPending={discovery.isPending}
          onScan={handleScan}
        />
      )}
      <TextGenerationSection />
    </SettingsPageContainer>
  );
}
