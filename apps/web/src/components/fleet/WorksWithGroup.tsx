import {
  type ComputerLinkAccess,
  type InboundComputerLink,
  RUNTIME_MODES,
  type RuntimeMode,
} from "@threadlines/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  type ComputerLinkTarget,
  describeComputerLinkFailure,
  linkComputerDirections,
  setComputerLinkAccess,
} from "../../environments/links/computerLinks";
import { cn } from "../../lib/utils";
import { runtimeModeConfig } from "../../runtimeModeOptions";
import { SETTINGS_GROUP_ROW_CLASS, SettingsGroup } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FLEET_GLYPH_ICONS } from "./FleetGraph";
import type { FleetGlyph } from "./fleet.logic";
import {
  canOfferLink,
  COMPUTER_LINK_ACCESS_LABELS,
  type FleetDirection,
  type FleetPair,
} from "./fleetLinks.logic";
import { LinkRequestRow } from "./LinkRequestRow";
import { UnlinkDialog } from "./UnlinkDialog";

const ACCESS_ORDER: readonly ComputerLinkAccess[] = ["allowed", "ask", "off"];

function targetOf(reach: {
  readonly environmentId: ComputerLinkTarget["environmentId"];
  readonly label: string;
}) {
  return { environmentId: reach.environmentId, label: reach.label };
}

function directionText(direction: FleetDirection): string {
  return `${direction.asker.label}'s agents can start work on ${direction.worker.label}`;
}

/**
 * An inbound link's two settings, on the computer they belong to: what the
 * other computer's agents may do (Allowed, Ask first, Off), and the most
 * access a thread they start there gets. Disabled with the reason when that
 * computer can't be reached; the last known values stay.
 */
export function LinkSettingsControls({
  worker,
  inbound,
  editable,
  testId,
}: {
  readonly worker: ComputerLinkTarget;
  readonly inbound: InboundComputerLink;
  readonly editable: boolean;
  readonly testId: string;
}) {
  const [optimistic, setOptimistic] = useState<{
    readonly access?: ComputerLinkAccess;
    readonly maxRuntimeMode?: RuntimeMode;
  }>({});
  const access = optimistic.access ?? inbound.access;
  const maxRuntimeMode = optimistic.maxRuntimeMode ?? inbound.maxRuntimeMode;
  const save = async (change: {
    readonly access?: ComputerLinkAccess;
    readonly maxRuntimeMode?: RuntimeMode;
  }) => {
    setOptimistic((current) => ({ ...current, ...change }));
    try {
      await setComputerLinkAccess(worker, { deviceId: inbound.deviceId, ...change });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not change it on ${worker.label}`,
          description: describeComputerLinkFailure(error, "Try again."),
        }),
      );
    } finally {
      setOptimistic((current) => {
        const next = { ...current };
        if (change.access !== undefined) delete next.access;
        if (change.maxRuntimeMode !== undefined) delete next.maxRuntimeMode;
        return next;
      });
    }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <Select
        value={access}
        disabled={!editable}
        onValueChange={(value) => void save({ access: value as ComputerLinkAccess })}
      >
        <SelectTrigger
          size="xs"
          className="w-28 min-w-0"
          aria-label="What its agents may do"
          data-testid={`${testId}-access`}
        >
          <SelectValue>{COMPUTER_LINK_ACCESS_LABELS[access]}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {ACCESS_ORDER.map((value) => (
            <SelectItem key={value} value={value}>
              {COMPUTER_LINK_ACCESS_LABELS[value]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Select
        value={maxRuntimeMode}
        disabled={!editable}
        onValueChange={(value) => void save({ maxRuntimeMode: value as RuntimeMode })}
      >
        <SelectTrigger
          size="xs"
          className="w-40 min-w-0"
          aria-label="Most access its threads get"
          data-testid={`${testId}-most-access`}
        >
          <SelectValue>Up to {runtimeModeConfig[maxRuntimeMode].label}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {RUNTIME_MODES.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {runtimeModeConfig[mode].label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** A disabled button keeps its reason in a tooltip, and in plain text beside it on touch. */
function LinkButton({
  label,
  blockedReason,
  busy,
  onClick,
  testId,
}: {
  readonly label: string;
  readonly blockedReason: string | null;
  readonly busy: boolean;
  readonly onClick: () => void;
  readonly testId: string;
}) {
  const button = (
    <Button
      size="xs"
      variant="outline"
      disabled={blockedReason !== null || busy}
      onClick={onClick}
      data-testid={testId}
    >
      {busy ? "Linking..." : label}
    </Button>
  );
  if (blockedReason === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{button}</span>} />
      <TooltipPopup side="top">{blockedReason}</TooltipPopup>
    </Tooltip>
  );
}

function DirectionLine({
  direction,
  testId,
  offerLink,
  linkBlockedReason,
  linking,
  linkError,
  onLink,
}: {
  readonly direction: FleetDirection;
  readonly testId: string;
  /** Offer Link for just this direction (the other one is linked). */
  readonly offerLink: boolean;
  readonly linkBlockedReason: string | null;
  readonly linking: boolean;
  readonly linkError: string | null;
  readonly onLink: () => void;
}) {
  const showSettings = direction.status === "linked" && direction.inbound !== null;
  const linkable = offerLink && canOfferLink(direction);
  const note =
    linkError ??
    direction.note ??
    (direction.status === "linked" ? direction.settingsNote : null) ??
    (direction.status === "linked" && direction.inbound === null
      ? `Linked. Its settings are on ${direction.worker.label}.`
      : null) ??
    (linkable ? linkBlockedReason : null);
  return (
    <div
      className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}
      data-testid={testId}
      data-status={direction.status}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-[13px] leading-[18px] text-foreground">{directionText(direction)}</p>
          {note ? (
            <p
              className={cn(
                "text-[12.5px] leading-[18px]",
                linkError !== null || direction.status === "broken"
                  ? "text-warning"
                  : "text-muted-foreground",
              )}
              data-testid={`${testId}-note`}
            >
              {linkError !== null || direction.status === "broken" ? (
                <TriangleAlertIcon aria-hidden className="me-1 inline size-3.5 -translate-y-px" />
              ) : null}
              {note}
            </p>
          ) : !showSettings && !linkable && direction.status === "none" ? (
            <p className="text-[12.5px] leading-[18px] text-muted-foreground">Not linked</p>
          ) : null}
        </div>
        {showSettings ? (
          <LinkSettingsControls
            worker={targetOf(direction.worker)}
            inbound={direction.inbound!}
            editable={direction.settingsEditable}
            testId={testId}
          />
        ) : linkable ? (
          <LinkButton
            label={
              linkError !== null ? "Retry" : direction.status === "none" ? "Link" : "Link again"
            }
            blockedReason={linkBlockedReason}
            busy={linking}
            onClick={onLink}
            testId={`${testId}-link`}
          />
        ) : null}
      </div>
    </div>
  );
}

type DirectionName = "outward" | "inward";

/**
 * One other computer, as the page's computer works with it: requests from it
 * waiting for an Allow, then each direction ("Mac's agents can start work on
 * Windows PC" and back) with its settings, or Link. With neither direction
 * linked, one Link makes both; Unlink removes both (docs/design/fleet.md,
 * R4.2).
 */
function PairRow({
  pair,
  glyph,
  runningStartedBy,
}: {
  readonly pair: FleetPair;
  readonly glyph: FleetGlyph;
  readonly runningStartedBy: (
    asker: ComputerLinkTarget["environmentId"],
    worker: ComputerLinkTarget["environmentId"],
  ) => number;
}) {
  const [linking, setLinking] = useState<ReadonlySet<DirectionName>>(new Set());
  const [linkErrors, setLinkErrors] = useState<Partial<Record<DirectionName, string>>>({});
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const Glyph = FLEET_GLYPH_ICONS[glyph];
  const directions: ReadonlyArray<readonly [DirectionName, FleetDirection]> = [
    ["outward", pair.outward],
    ["inward", pair.inward],
  ];
  const linkedEither = directions.some(
    ([, direction]) => direction.status !== "none" || direction.inbound !== null,
  );

  const link = async (names: ReadonlyArray<DirectionName>) => {
    setLinking(new Set(names));
    setLinkErrors((current) => {
      const next = { ...current };
      for (const name of names) delete next[name];
      return next;
    });
    const byName = new Map(directions);
    const results = await linkComputerDirections(
      names.map((name) => {
        const direction = byName.get(name)!;
        return { asker: targetOf(direction.asker), worker: targetOf(direction.worker) };
      }),
    );
    setLinking(new Set());
    const errors: Partial<Record<DirectionName, string>> = {};
    results.forEach((result, index) => {
      if (result.error !== null) errors[names[index]!] = result.error;
    });
    setLinkErrors((current) => ({ ...current, ...errors }));
  };

  const pending = pair.inward.pending;
  const testId = `fleet-pair-${pair.other.environmentId}`;
  return (
    <SettingsGroup data-testid={testId}>
      <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}>
        <div className="flex min-h-7 items-center gap-2.5">
          <Glyph aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <h3 className="min-w-0 flex-1 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
            {pair.other.label}
          </h3>
          {pair.linked ? (
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => setUnlinkOpen(true)}
              data-testid={`${testId}-unlink`}
            >
              Unlink
            </Button>
          ) : (
            <LinkButton
              label={Object.keys(linkErrors).length > 0 ? "Retry" : "Link"}
              blockedReason={pair.linkBlockedReason}
              busy={linking.size > 0}
              onClick={() =>
                void link(
                  Object.keys(linkErrors).length > 0
                    ? (Object.keys(linkErrors) as DirectionName[])
                    : ["outward", "inward"],
                )
              }
              testId={`${testId}-link`}
            />
          )}
        </div>
        {!pair.linked && Object.keys(linkErrors).length === 0 ? (
          <p className="mt-0.5 ps-6.5 text-[12.5px] leading-[18px] text-muted-foreground">
            {pair.linkBlockedReason ?? "Not linked"}
          </p>
        ) : null}
      </div>
      {pending.map((request) => (
        <LinkRequestRow key={request.requestId} request={request} worker={targetOf(pair.self)} />
      ))}
      {/* Neither way linked: the one Link above covers both, and the lines
          show only to say what failed. */}
      {(pair.linked || Object.keys(linkErrors).length > 0 ? directions : []).map(
        ([name, direction]) => (
          <DirectionLine
            key={name}
            direction={direction}
            testId={`${testId}-${name}`}
            offerLink={linkedEither || linkErrors[name] !== undefined}
            linkBlockedReason={pair.linkBlockedReason}
            linking={linking.has(name)}
            linkError={linkErrors[name] ?? null}
            onLink={() => void link([name])}
          />
        ),
      )}
      {unlinkOpen ? (
        <UnlinkDialog
          pair={pair}
          runningStartedBy={runningStartedBy}
          onClose={() => setUnlinkOpen(false)}
        />
      ) : null}
    </SettingsGroup>
  );
}

/**
 * "Works with other computers" on a computer's Fleet page: a pair row for
 * every other computer in the fleet, named on both sides, so it reads the
 * same from the desktop, the hosted app and a phone.
 */
export function WorksWithGroup({
  pairs,
  glyphOf,
  runningStartedBy,
  children,
}: {
  readonly pairs: ReadonlyArray<FleetPair>;
  readonly glyphOf: (environmentId: ComputerLinkTarget["environmentId"]) => FleetGlyph;
  readonly runningStartedBy: (
    asker: ComputerLinkTarget["environmentId"],
    worker: ComputerLinkTarget["environmentId"],
  ) => number;
  /** Rows for linked computers that haven't said who they are yet. */
  readonly children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid="fleet-works-with">
      <div className="space-y-0.5 px-1">
        <h2 className="text-[15px] leading-5 font-semibold text-foreground">
          Works with other computers
        </h2>
        <p className="text-[12.5px] leading-[18px] text-muted-foreground">
          Whether agents on one computer may start threads on another.
        </p>
      </div>
      {pairs.length === 0 && !children ? (
        <SettingsGroup>
          <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-3")}>
            <p className="text-[12.5px] leading-[18px] text-muted-foreground">
              Connect another computer to let agents work across them.
            </p>
          </div>
        </SettingsGroup>
      ) : null}
      {pairs.map((pair) => (
        <PairRow
          key={pair.other.environmentId}
          pair={pair}
          glyph={glyphOf(pair.other.environmentId)}
          runningStartedBy={runningStartedBy}
        />
      ))}
      {children}
    </section>
  );
}
