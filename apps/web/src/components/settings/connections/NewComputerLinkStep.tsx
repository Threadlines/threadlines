import type { EnvironmentId } from "@threadlines/contracts";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  type ComputerLinkTarget,
  linkComputerDirections,
  useComputerLinksStore,
} from "~/environments/links/computerLinks";
import { usePrimaryEnvironmentDescriptor } from "~/environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { getWsConnectionUiState, useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { Button } from "../../ui/button";
import { DialogFooter, DialogPanel } from "../../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";

interface LinkPartner extends ComputerLinkTarget {}

/**
 * Who a newly connected computer could be linked with (docs/design/fleet.md,
 * R4.3): this app's own computer on the desktop or in a browser it serves;
 * on the hosted app or a phone, the other saved computers. Both must be
 * connected and take links. Null while the new computer is still connecting.
 */
export function useNewComputerLinkPartners(newComputer: ComputerLinkTarget): {
  readonly ready: boolean;
  readonly partners: ReadonlyArray<LinkPartner>;
  /** No server of its own (hosted app, phone): the user picks which computer to link with. */
  readonly choosePartner: boolean;
} {
  const primary = usePrimaryEnvironmentDescriptor();
  const primaryConnected =
    getWsConnectionUiState(useWsConnectionStatus()) === "connected" && primary !== null;
  const savedRecords = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const links = useComputerLinksStore((state) => state.byEnvironmentId);
  return useMemo(() => {
    const runtime = savedRuntime[newComputer.environmentId];
    const choosePartner = primary === null;
    if (runtime?.connectionState !== "connected" || runtime.descriptor === null) {
      return { ready: false, partners: [], choosePartner };
    }
    if (runtime.descriptor.capabilities.computerLinks !== true) {
      return { ready: true, partners: [], choosePartner };
    }
    const candidates: LinkPartner[] =
      primary !== null
        ? primaryConnected && primary.capabilities.computerLinks === true
          ? [{ environmentId: primary.environmentId, label: primary.label }]
          : []
        : Object.values(savedRecords).flatMap((record): LinkPartner[] => {
            if (record.environmentId === newComputer.environmentId) return [];
            const other = savedRuntime[record.environmentId];
            if (other?.connectionState !== "connected") return [];
            if (other.descriptor?.capabilities.computerLinks !== true) return [];
            return [
              {
                environmentId: record.environmentId,
                label: record.label.trim() || other.descriptor.label,
              },
            ];
          });
    // A pair already linked both ways has nothing to ask.
    const partners = candidates.filter(
      (partner) => missingDirections(partner, newComputer, links).length > 0,
    );
    return { ready: true, partners, choosePartner };
  }, [links, newComputer, primary, primaryConnected, savedRecords, savedRuntime]);
}

function missingDirections(
  partner: ComputerLinkTarget,
  newComputer: ComputerLinkTarget,
  links: ReturnType<typeof useComputerLinksStore.getState>["byEnvironmentId"],
): Array<{ readonly asker: ComputerLinkTarget; readonly worker: ComputerLinkTarget }> {
  const has = (asker: ComputerLinkTarget, worker: ComputerLinkTarget) =>
    links[asker.environmentId]?.snapshot.outbound.some(
      (link) => link.remoteEnvironmentId === worker.environmentId && link.state === "active",
    ) === true;
  return [
    { asker: partner, worker: newComputer },
    { asker: newComputer, worker: partner },
  ].filter((direction) => !has(direction.asker, direction.worker));
}

/**
 * The Connect dialog's last step: "Let agents on these computers start work
 * on each other?" Link makes both directions at the receiving computer's
 * default, Ask first, and each direction says if it failed (Retry tries
 * only those). Not now closes.
 */
export function NewComputerLinkStep({
  newComputer,
  partners,
  choosePartner,
  connectedNote,
  onClose,
}: {
  readonly newComputer: ComputerLinkTarget;
  readonly partners: ReadonlyArray<LinkPartner>;
  /** Show which computer it links with ("Link with: Mac"), and let the user pick. */
  readonly choosePartner: boolean;
  /** The line saying the computer is connected, above the question. */
  readonly connectedNote: string;
  readonly onClose: () => void;
}) {
  const [partnerId, setPartnerId] = useState<EnvironmentId>(partners[0]!.environmentId);
  const partner = partners.find((entry) => entry.environmentId === partnerId) ?? partners[0]!;
  const links = useComputerLinksStore((state) => state.byEnvironmentId);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<ReadonlyArray<{
    readonly asker: ComputerLinkTarget;
    readonly worker: ComputerLinkTarget;
    readonly error: string;
  }> | null>(null);

  const link = async () => {
    setBusy(true);
    const directions =
      failures?.map(({ asker, worker }) => ({ asker, worker })) ??
      missingDirections(partner, newComputer, links);
    const results = await linkComputerDirections(directions);
    setBusy(false);
    const failed = results.flatMap((result) =>
      result.error === null
        ? []
        : [{ asker: result.asker, worker: result.worker, error: result.error }],
    );
    if (failed.length === 0) {
      toastManager.add({
        type: "success",
        title: `${partner.label} and ${newComputer.label} are linked`,
        description: "Agents on either one ask first before starting work on the other.",
      });
      onClose();
      return;
    }
    setFailures(failed);
  };

  return (
    <>
      <DialogPanel className="space-y-4">
        <div className="flex items-start gap-2.5">
          <CircleCheckIcon aria-hidden className="mt-0.5 size-4.5 shrink-0 text-success" />
          <p className="text-sm font-medium text-foreground">{connectedNote}</p>
        </div>
        <div className="space-y-2 border-t border-group-divider pt-3.5">
          <p className="text-sm font-medium text-foreground">
            Let agents on these computers start work on each other?
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Each thread one starts on the other waits for you to allow it. You can change this in
            Fleet.
          </p>
          {choosePartner || partners.length > 1 ? (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">Link with</span>
              <Select
                value={partner.environmentId}
                onValueChange={(value) => {
                  setPartnerId(value as EnvironmentId);
                  setFailures(null);
                }}
              >
                <SelectTrigger size="sm" className="w-44" aria-label="Link with">
                  <SelectValue>{partner.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {partners.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          {failures !== null ? (
            <ul className="space-y-1 pt-1" data-testid="connect-link-failures">
              {failures.map((failure) => (
                <li
                  key={`${failure.asker.environmentId}>${failure.worker.environmentId}`}
                  className="flex items-start gap-1.5 text-xs text-warning"
                >
                  <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                  <span>
                    {failure.asker.label}&apos;s agents on {failure.worker.label}: {failure.error}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter className="items-center">
        <span className="flex-1" />
        <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
          Not now
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void link()}
          data-testid="connect-link-confirm"
        >
          {busy ? <Spinner className="size-3.5" /> : null}
          {failures !== null ? "Retry" : "Link (Ask first)"}
        </Button>
      </DialogFooter>
    </>
  );
}
