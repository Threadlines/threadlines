/**
 * A computer's menu on the Fleet pages: what right-click (or a held finger)
 * opens on a computer in the list or on the map, and what the list's ⋯
 * button opens. A computer: Open and Rename. A phone or tablet on the map:
 * Rename and Connections settings. Rename is read as the computer is when
 * the menu opens, and is shown but off while it can't take a name (offline,
 * or a version too old for names).
 */
import { AuthSessionId, type ContextMenuItem } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { readLocalApi } from "../../localApi";
import {
  openComputerRenameDialog,
  openDeviceRenameDialog,
  readComputerNaming,
  readDeviceNamesAvailable,
} from "../DeviceRenameDialog";
import type { FleetComputer } from "./fleet.logic";
import { type FleetDirectoryEntry, fleetEntryRoute } from "./fleetLinks.logic";

export type FleetMenuAction = "open" | "rename" | "connections";

/** A computer as its list row or map node knows it, or a phone or tablet on the map. */
export type FleetMenuTarget =
  | { readonly kind: "computer"; readonly entry: FleetDirectoryEntry }
  | { readonly kind: "device"; readonly computer: FleetComputer };

/**
 * The menu's items. A computer this app doesn't reach (linked through
 * another, or still saying which it is) is only opened: it is renamed where
 * it is reached.
 */
export function describeFleetComputerMenu(input: {
  readonly target: FleetMenuTarget;
  readonly canRename: boolean;
}): ContextMenuItem<FleetMenuAction>[] {
  if (input.target.kind === "device") {
    return [
      { id: "rename", label: "Rename…", disabled: !input.canRename },
      { id: "connections", label: "Connections settings" },
    ];
  }
  const { kind } = input.target.entry;
  return kind === "this" || kind === "saved"
    ? [
        { id: "open", label: "Open" },
        { id: "rename", label: "Rename…", disabled: !input.canRename },
      ]
    : [{ id: "open", label: "Open" }];
}

/**
 * Opens a computer's menu at `position` and does what is picked.
 * `beforeNavigate` runs before Open or Connections settings leaves the page
 * (the phone's list sheet closes).
 */
export function useFleetComputerMenu() {
  const navigate = useNavigate();
  return useCallback(
    async (
      target: FleetMenuTarget,
      position: { readonly x: number; readonly y: number },
      beforeNavigate?: () => void,
    ) => {
      const api = readLocalApi();
      if (!api) return;
      const environmentId = target.kind === "computer" ? target.entry.environmentId : null;
      const canRename =
        target.kind === "device"
          ? readDeviceNamesAvailable() && target.computer.device !== undefined
          : environmentId !== null && readComputerNaming(environmentId) !== null;
      const clicked = await api.contextMenu.show(
        describeFleetComputerMenu({ target, canRename }),
        position,
      );
      switch (clicked) {
        case "open":
          if (target.kind === "computer") {
            beforeNavigate?.();
            void navigate(fleetEntryRoute(target.entry));
          }
          return;
        case "connections":
          beforeNavigate?.();
          void navigate({ to: "/settings/connections" });
          return;
        case "rename": {
          if (target.kind === "device") {
            const device = target.computer.device;
            if (device === undefined) return;
            openDeviceRenameDialog({
              sessionId: AuthSessionId.make(device.sessionId),
              shownAs: target.computer.label,
              label: device.name,
              deviceLabel: device.ownName,
            });
            return;
          }
          // As the computer is now: it may have gone offline while the menu was open.
          const naming = environmentId === null ? null : readComputerNaming(environmentId);
          if (naming !== null) openComputerRenameDialog(naming);
          return;
        }
        case null:
          return;
      }
    },
    [navigate],
  );
}
