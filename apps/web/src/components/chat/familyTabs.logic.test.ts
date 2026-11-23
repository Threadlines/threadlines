import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { InboxRemoteChild, ThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import {
  type FamilyTab,
  type FamilyTabEntry,
  familyTabsOf,
  fitFamilyTabs,
} from "./familyTabs.logic";

const environmentId = EnvironmentId.make("environment-local");
const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
const NOW = "2026-11-16T12:00:00.000Z";
const working: ThreadStatusPill = {
  label: "Working",
  colorClass: "text-working",
  dotClass: "dot-working",
  pulse: true,
};
const approval: ThreadStatusPill = {
  label: "Pending Approval",
  colorClass: "text-approval",
  dotClass: "dot-approval",
  pulse: false,
};

function entry(
  id: string,
  options: {
    parent?: string;
    attached?: boolean;
    createdAt?: string;
    status?: ThreadStatusPill | null;
    done?: boolean;
    seenAt?: string;
    wrappedByUser?: boolean;
    lead?: boolean;
  } = {},
): FamilyTabEntry {
  const createdAt = options.createdAt ?? "2026-11-16T10:00:00.000Z";
  return {
    threadKey: keyOf(id),
    thread: {
      id: ThreadId.make(id),
      environmentId,
      title: `Title ${id}`,
      createdAt,
      parentThreadId: options.parent === undefined ? null : ThreadId.make(options.parent),
      attachedToParent: options.attached ?? options.parent !== undefined,
    } as SidebarThreadSummary,
    status: options.status ?? null,
    isDone: options.done ?? false,
    settledAt: createdAt,
    seenAt: options.seenAt,
    deliveredAt: null,
    wrappedByUser: options.wrappedByUser ?? false,
    isLead: options.lead ?? false,
  };
}

const tabsFor = (open: string, entries: readonly FamilyTabEntry[]) =>
  familyTabsOf({
    openKey: keyOf(open),
    entries,
    remoteChildrenOf: () => [],
    canReadLinked: () => true,
    now: NOW,
  });

const windowsId = EnvironmentId.make("environment-windows");
const windowsKeyOf = (id: string) => scopedThreadKey(scopeThreadRef(windowsId, ThreadId.make(id)));
function remoteChild(
  id: string,
  options: { threadId?: string | null; done?: boolean } = {},
): InboxRemoteChild {
  const threadId = options.threadId === undefined ? id : options.threadId;
  return {
    threadKey: threadId === null ? `start:${windowsId}:${id}` : windowsKeyOf(threadId),
    environmentId: windowsId,
    threadId: threadId === null ? null : ThreadId.make(threadId),
    computerLabel: "Windows PC",
    title: `Remote ${id}`,
    phase: options.done ? "wrapped" : threadId === null ? "sending" : "working",
    status: options.done ? null : working,
    isDone: options.done ?? false,
    // Wrapped and already seen through the parent: gone from the live family.
    settledAt: "2026-11-16T10:00:00.000Z",
    seenAt: "2026-11-16T11:00:00.000Z",
  };
}

describe("family tabs", () => {
  const family = [
    entry("lead", { lead: true }),
    entry("second", { parent: "lead", createdAt: "2026-11-16T10:02:00.000Z", status: approval }),
    entry("first", { parent: "lead", createdAt: "2026-11-16T10:01:00.000Z", status: working }),
    entry("alone"),
  ];

  it("shows the parent first, then its threads oldest first, the same row from any member", () => {
    const onParent = tabsFor("lead", family);
    const onChild = tabsFor("second", family);
    expect(onParent?.tabs.map((tab) => tab.key)).toEqual([
      keyOf("lead"),
      keyOf("first"),
      keyOf("second"),
    ]);
    expect(onChild?.familyKey).toBe(keyOf("lead"));
    expect(onChild?.tabs.map((tab) => tab.key)).toEqual(onParent?.tabs.map((tab) => tab.key));
    expect(onParent?.tabs[0]).toMatchObject({ kind: "parent", lead: true });
    expect(onParent?.tabs[2]).toMatchObject({ statusWord: "approval", needsYou: true });
  });

  it("has no row on a thread with no family, a child the user made its own, or under a wrapped parent", () => {
    expect(tabsFor("alone", family)).toBeNull();
    const separated = [entry("parent"), entry("own", { parent: "parent", attached: false })];
    expect(tabsFor("own", separated)).toBeNull();
    expect(tabsFor("parent", separated)).toBeNull();
    const wrappedParent = [entry("parent", { done: true }), entry("child", { parent: "parent" })];
    expect(tabsFor("child", wrappedParent)).toBeNull();
  });

  it("drops a child the user wrapped, as the sidebar does, but never the open one", () => {
    const wrapped = [
      entry("parent"),
      entry("kept", { parent: "parent" }),
      entry("gone", { parent: "parent", done: true, wrappedByUser: true }),
    ];
    expect(tabsFor("parent", wrapped)?.tabs.map((tab) => tab.key)).toEqual([
      keyOf("parent"),
      keyOf("kept"),
    ]);
    const openGone = tabsFor("gone", wrapped);
    expect(openGone?.tabs.find((tab) => tab.key === keyOf("gone"))).toMatchObject({ done: true });
  });
});

describe("family tabs with children on a computer this app can't see", () => {
  const parent = entry("parent");
  const children = [remoteChild("busy"), remoteChild("asked", { threadId: null })];
  const tabs = (input: {
    open: string;
    parentKey?: string;
    remote?: readonly InboxRemoteChild[];
    readsLinked?: boolean;
  }) =>
    familyTabsOf({
      openKey: input.open,
      parentKey: input.parentKey,
      entries: [parent],
      remoteChildrenOf: () => input.remote ?? children,
      canReadLinked: () => input.readsLinked ?? true,
      now: NOW,
    });

  it("opens a child there through the link only where the parent's computer reads it", () => {
    const reading = tabs({ open: keyOf("parent") });
    expect(reading?.tabs.map((tab) => tab.linkedRef)).toEqual([
      null,
      scopeThreadRef(windowsId, ThreadId.make("busy")),
      // A start with no thread there yet has nothing to read.
      null,
    ]);
    const older = tabs({ open: keyOf("parent"), readsLinked: false });
    expect(older?.tabs.every((tab) => tab.linkedRef === null)).toBe(true);
    // Nor once the parent's computer no longer links there.
    const unlinked = tabs({
      open: keyOf("parent"),
      remote: [{ ...remoteChild("busy"), unlinked: true }],
    });
    expect(unlinked?.tabs[1]?.linkedRef).toBeNull();
  });

  it("shows the row on a child open through the link, and keeps it there once wrapped", () => {
    const open = tabs({
      open: windowsKeyOf("finished"),
      parentKey: keyOf("parent"),
      remote: [remoteChild("finished", { done: true })],
    });
    expect(open?.familyKey).toBe(keyOf("parent"));
    expect(open?.openKey).toBe(windowsKeyOf("finished"));
    expect(open?.tabs.map((tab) => tab.key)).toEqual([keyOf("parent"), windowsKeyOf("finished")]);
    // Not open: it has left the family, so the parent has no row.
    expect(
      tabs({ open: keyOf("parent"), remote: [remoteChild("finished", { done: true })] }),
    ).toBeNull();
  });
});

describe("fitting the row", () => {
  const tab = (key: string, needsYou = false): FamilyTab => ({
    key,
    threadRef: null,
    linkedRef: null,
    kind: "child",
    title: key,
    shortTitle: key,
    lead: false,
    dotClass: null,
    statusWord: null,
    done: false,
    needsYou,
    computerLabel: null,
    inbox: null,
  });
  const tabs = ["a", "b", "c", "d", "e", "f"].map((key) => tab(key, key === "f"));
  const fit = (openKey: string, rowPx: number, floors: Record<string, number> = {}, gapPx = 0) =>
    fitFamilyTabs({
      tabs,
      openKey,
      rowPx,
      overflowPx: 40,
      gapPx,
      floorPx: (entry) => floors[entry.key] ?? 100,
    });
  const keys = (list: readonly FamilyTab[]) => list.map((entry) => entry.key);

  it("keeps every tab while they fit at their floors, else moves the last behind +N", () => {
    expect(fit("a", 600).hidden).toEqual([]);
    // Two pixels between tabs: six 100px tabs no longer fit in 600.
    expect(keys(fit("a", 600, {}, 2).hidden)).toEqual(["f"]);
    const tight = fit("a", 340);
    expect(keys(tight.shown)).toEqual(["a", "b", "c"]);
    expect(keys(tight.hidden)).toEqual(["d", "e", "f"]);
    expect(tight.hidden.some((entry) => entry.needsYou)).toBe(true);
  });

  it("charges a short title only its own width", () => {
    const short = { a: 60, b: 30, c: 30, d: 30, e: 30, f: 30 };
    expect(fit("a", 220, short).hidden).toEqual([]);
  });

  it("always keeps the parent's tab and the open thread's on the row", () => {
    const tight = fit("e", 340);
    expect(keys(tight.shown)).toEqual(["a", "b", "e"]);
    expect(keys(tight.hidden)).toEqual(["c", "d", "f"]);
    // Too narrow for both: neither gives way.
    expect(keys(fit("e", 150).shown)).toEqual(["a", "e"]);
  });
});
