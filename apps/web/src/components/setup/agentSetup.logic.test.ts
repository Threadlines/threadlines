import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@threadlines/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@threadlines/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderEnablementPatch,
  deriveMaintainedProviderRows,
  groupProviderRows,
  type HeldProviderRows,
  holdProviderRow,
  pruneHeldProviderRows,
} from "../settings/providerEnablement";
import {
  deriveInitialPicks,
  deriveSetupAgents,
  setupEnablementChanges,
  stepAfterAgents,
} from "./agentSetup.logic";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const OPENCODE = ProviderDriverKind.make("opencode");

type SnapshotState = "ready" | "signedOut" | "missing" | "pending" | "offFound" | "offMissing";

function snapshot(driver: ProviderDriverKind, state: SnapshotState): ServerProvider {
  const enabled = state !== "offFound" && state !== "offMissing";
  return {
    driver,
    instanceId: ProviderInstanceId.make(driver),
    enabled,
    installed: state === "ready" || state === "signedOut",
    version: null,
    status: enabled ? (state === "ready" ? "ready" : "warning") : "disabled",
    ...(state === "pending" ? { statusReason: "provider_probe_pending" as const } : {}),
    auth:
      state === "ready"
        ? { status: "authenticated" }
        : state === "signedOut"
          ? { status: "unauthenticated" }
          : { status: "unknown" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [],
    ...(state === "offFound" ? { detection: { status: "found" as const, path: "/bin/x" } } : {}),
    ...(state === "offMissing" ? { detection: { status: "notFound" as const } } : {}),
  };
}

// Built-in defaults: Codex and Claude on, the four newer agents off.
const SETTINGS = DEFAULT_UNIFIED_SETTINGS as ServerSettings;

function agentsFor(states: Partial<Record<ProviderDriverKind, SnapshotState>>) {
  const rows = deriveMaintainedProviderRows(SETTINGS);
  const providers = Object.entries(states).map(([driver, state]) =>
    snapshot(ProviderDriverKind.make(driver), state!),
  );
  return deriveSetupAgents({ rows, providers });
}

describe("agent setup", () => {
  it("waits for turned-on agents to be checked, then picks everything on this computer", () => {
    const stillChecking = agentsFor({
      [CODEX]: "pending",
      [CLAUDE]: "ready",
      [CURSOR]: "offFound",
    });
    expect(deriveInitialPicks(stillChecking)).toBeNull();
    // After the bounded wait, an agent that is already on counts as picked.
    expect(deriveInitialPicks(stillChecking, { force: true })).toEqual(
      new Set([CODEX, CLAUDE, CURSOR]),
    );

    const checked = agentsFor({
      [CODEX]: "missing",
      [CLAUDE]: "signedOut",
      [CURSOR]: "offFound",
      [OPENCODE]: "offMissing",
    });
    expect(deriveInitialPicks(checked)).toEqual(new Set([CLAUDE, CURSOR]));
  });

  it("skips Connect only when every picked agent already works", () => {
    const agents = agentsFor({ [CODEX]: "signedOut", [CLAUDE]: "ready" });

    expect(stepAfterAgents(agents, new Set([CLAUDE]))).toBe("folder");
    expect(stepAfterAgents(agents, new Set([CLAUDE, CODEX]))).toBe("connect");
    expect(stepAfterAgents(agents, new Set())).toBe("connect");
  });

  it("turns picked agents on and the rest off in one write that keeps custom instances", () => {
    const settings = {
      ...SETTINGS,
      providerInstances: {
        ...SETTINGS.providerInstances,
        [ProviderInstanceId.make("codex_work")]: { driver: CODEX, enabled: true },
      },
    } as ServerSettings;
    const rows = deriveMaintainedProviderRows(settings);
    const agents = deriveSetupAgents({ rows, providers: [] });

    const patch = buildProviderEnablementPatch({
      settings,
      changes: setupEnablementChanges(agents, new Set([CLAUDE, CURSOR])),
    });

    const instances = patch.providerInstances ?? {};
    expect(instances[ProviderInstanceId.make("codex")]?.enabled).toBe(false);
    expect(instances[ProviderInstanceId.make("claudeAgent")]?.enabled ?? true).toBe(true);
    expect(instances[ProviderInstanceId.make("cursor")]?.enabled).toBe(true);
    expect(instances[ProviderInstanceId.make("codex_work")]).toEqual({
      driver: CODEX,
      enabled: true,
    });
  });
});

describe("Providers page groups", () => {
  const rows = deriveMaintainedProviderRows(SETTINGS);
  const rowFor = (driver: ProviderDriverKind) => rows.find((row) => row.driver === driver)!;
  const drivers = (group: ReadonlyArray<{ readonly driver: ProviderDriverKind }>) =>
    group.map((row) => row.driver);
  const NONE: HeldProviderRows = new Map();

  it("keeps a switched row in its group until it is let go", () => {
    // Codex is on by default. Switching it off holds it under "In use".
    const held = holdProviderRow(NONE, rowFor(CODEX), false);
    const switchedOff = rows.map((row) =>
      row.driver === CODEX ? { ...row, instance: { ...row.instance, enabled: false } } : row,
    );

    expect(drivers(groupProviderRows(switchedOff, held).inUse)).toContain(CODEX);
    // Let go (the pointer left the list): it settles under "Not in use".
    expect(drivers(groupProviderRows(switchedOff, NONE).notInUse)).toContain(CODEX);
  });

  it("lets go of a row that is switched straight back", () => {
    const held = holdProviderRow(NONE, rowFor(CODEX), false);
    const switchedOff = {
      ...rowFor(CODEX),
      instance: { ...rowFor(CODEX).instance, enabled: false },
    };

    expect(holdProviderRow(held, switchedOff, true).size).toBe(0);
  });

  it("drops a hold once the row is back where it was held, or gone", () => {
    const held = holdProviderRow(NONE, rowFor(CODEX), false);
    const switchedOff = rows.map((row) =>
      row.driver === CODEX ? { ...row, instance: { ...row.instance, enabled: false } } : row,
    );

    // Still switched off: the hold stands (and the map is not rebuilt).
    expect(pruneHeldProviderRows(held, switchedOff)).toBe(held);
    // The write failed and Codex is on again, where it was held: nothing to hold.
    expect(pruneHeldProviderRows(held, rows).size).toBe(0);
    // The row was deleted elsewhere.
    expect(
      pruneHeldProviderRows(
        held,
        switchedOff.filter((row) => row.driver !== CODEX),
      ).size,
    ).toBe(0);
  });
});
