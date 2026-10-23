import type {
  AuthClientSession,
  AuthPairingLink,
  AuthSessionRole,
  ServerAuthPolicy,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useEffectEvent, useState } from "react";

import {
  fetchSessionState,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "../environments/primary";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";

/**
 * Who this window is to this computer's server: its owner (the desktop app,
 * or the browser it opened) or a device it let in. Null until known, and
 * always null when `enabled` is false (the phone app has no server of its
 * own). Owner is what device management and the devices on the Fleet page
 * need.
 */
export function usePrimarySessionAccess(enabled: boolean): {
  readonly role: AuthSessionRole | null;
  readonly authPolicy: ServerAuthPolicy | null;
} {
  const desktopBridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [role, setRole] = useState<AuthSessionRole | null>(desktopBridge ? "owner" : null);
  const [authPolicy, setAuthPolicy] = useState<ServerAuthPolicy | null>(null);

  useEffect(() => {
    // The desktop app is always its own server's owner (the initial state).
    if (!enabled || desktopBridge) {
      return;
    }
    let cancelled = false;
    void fetchSessionState()
      .then((session) => {
        if (cancelled) return;
        setRole(session.authenticated ? (session.role ?? null) : null);
        setAuthPolicy(session.auth.policy);
      })
      .catch(() => {
        if (cancelled) return;
        setRole(null);
        setAuthPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopBridge, enabled]);

  return { role: enabled ? role : null, authPolicy: enabled ? authPolicy : null };
}

function sortPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function sortClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

function toPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

function toClientSessionRecord(clientSession: AuthClientSession): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

function upsertBy<T>(
  current: ReadonlyArray<T>,
  next: T,
  sameItem: (left: T, right: T) => boolean,
  sort: (items: ReadonlyArray<T>) => T[],
): T[] {
  const existingIndex = current.findIndex((item) => sameItem(item, next));
  if (existingIndex === -1) {
    return sort([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sort(updated);
}

export interface AuthAccessState {
  /** One-time links that let a device in, newest first. */
  readonly pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  /** Every session with access: this window first, then connected ones. */
  readonly clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  /** True until the first snapshot, and again while the stream reconnects. */
  readonly isLoading: boolean;
}

const EMPTY_AUTH_ACCESS: AuthAccessState = {
  pairingLinks: [],
  clientSessions: [],
  isLoading: false,
};

/**
 * This computer's pairing links and the devices with access to it, kept live
 * from its server's `subscribeAuthAccess` stream. Settings › Connections
 * manages them; the Fleet page draws the phones and tablets among them. Pass
 * `enabled` only for an owner session: anyone else gets an empty answer.
 * `onEvent` runs on every word from the stream.
 */
export function useAuthAccess(
  enabled: boolean,
  options?: { readonly onEvent?: () => void },
): AuthAccessState {
  const [state, setState] = useState<AuthAccessState>({ ...EMPTY_AUTH_ACCESS, isLoading: true });
  const notifyEvent = useEffectEvent(() => options?.onEvent?.());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    const unsubscribe = getPrimaryEnvironmentConnection().client.server.subscribeAuthAccess(
      (event) => {
        if (cancelled) return;
        notifyEvent();
        setState((current) => {
          switch (event.type) {
            case "snapshot":
              return {
                pairingLinks: sortPairingLinks(event.payload.pairingLinks.map(toPairingLinkRecord)),
                clientSessions: sortClientSessions(
                  event.payload.clientSessions.map(toClientSessionRecord),
                ),
                isLoading: false,
              };
            case "pairingLinkUpserted":
              return {
                ...current,
                pairingLinks: upsertBy(
                  current.pairingLinks,
                  toPairingLinkRecord(event.payload),
                  (left, right) => left.id === right.id,
                  sortPairingLinks,
                ),
                isLoading: false,
              };
            case "pairingLinkRemoved":
              return {
                ...current,
                pairingLinks: current.pairingLinks.filter((link) => link.id !== event.payload.id),
                isLoading: false,
              };
            case "clientUpserted":
              return {
                ...current,
                clientSessions: upsertBy(
                  current.clientSessions,
                  toClientSessionRecord(event.payload),
                  (left, right) => left.sessionId === right.sessionId,
                  sortClientSessions,
                ),
                isLoading: false,
              };
            case "clientRemoved":
              return {
                ...current,
                clientSessions: current.clientSessions.filter(
                  (session) => session.sessionId !== event.payload.sessionId,
                ),
                isLoading: false,
              };
          }
        });
      },
      {
        onResubscribe: () => {
          if (!cancelled) {
            setState((current) => ({ ...current, isLoading: true }));
          }
        },
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  return enabled ? state : EMPTY_AUTH_ACCESS;
}
