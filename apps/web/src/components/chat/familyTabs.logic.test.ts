import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadStatusPill } from "../Sidebar.logic";
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
  familyTabsOf({ openKey: keyOf(open), entries, remoteChildrenOf: () => [], now: NOW });

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

describe("fitting the row", () => {
  const tab = (key: string, needsYou = false): FamilyTab => ({
    key,
    threadRef: null,
    kind: "child",
    title: key,
    lead: false,
    dotClass: null,
    statusWord: null,
    done: false,
    needsYou,
    computerLabel: null,
    inbox: null,
  });
  const tabs = ["a", "b", "c", "d", "e", "f"].map((key) => tab(key, key === "f"));

  it("keeps every tab while they fit at the floor, else moves the last behind +N", () => {
    expect(fitFamilyTabs({ tabs, openKey: "a", rowPx: 600, overflowPx: 40 }).hidden).toEqual([]);
    const tight = fitFamilyTabs({ tabs, openKey: "a", rowPx: 340, overflowPx: 40 });
    expect(tight.shown.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
    expect(tight.hidden.map((entry) => entry.key)).toEqual(["d", "e", "f"]);
    expect(tight.hidden.some((entry) => entry.needsYou)).toBe(true);
  });

  it("always keeps the open thread's tab on the row", () => {
    const tight = fitFamilyTabs({ tabs, openKey: "e", rowPx: 340, overflowPx: 40 });
    expect(tight.shown.map((entry) => entry.key)).toEqual(["a", "b", "e"]);
    expect(tight.hidden.map((entry) => entry.key)).toEqual(["c", "d", "f"]);
  });
});
