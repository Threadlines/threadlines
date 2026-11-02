import type * as Electron from "electron";
import { describe, expect, it } from "vite-plus/test";

import { makePreviewScopeRegistry } from "./PreviewScopes.ts";
import { previewProfilePartition, previewSharedPartition } from "./previewPartitions.ts";

const page = (type: "webview" | "window" = "webview") =>
  ({ getType: () => type }) as unknown as Electron.WebContents;

describe("makePreviewScopeRegistry", () => {
  it("gives a page the project its attach named, and only the page created right then", async () => {
    const registry = makePreviewScopeRegistry();
    const shared = previewSharedPartition("environment-1");
    const projectA = previewProfilePartition("environment-1", "project-a");
    const projectB = previewProfilePartition("environment-1", "project-b");
    registry.issue(shared, projectA);
    registry.issue(shared, projectB);

    expect(registry.expectGuest(shared, projectA)).toBe(projectA);
    const first = page();
    registry.claim(first);
    expect(registry.scopeOf(first)).toBe(projectA);

    // A page created with nothing expected has no project, even one created
    // later in the same task than an attach whose guest already came.
    const stray = page();
    registry.claim(stray);
    expect(registry.scopeOf(stray)).toBeNull();

    // An attach whose guest never came stops counting once the task ends.
    expect(registry.expectGuest(shared, projectB)).toBe(projectB);
    await Promise.resolve();
    const late = page();
    registry.claim(late);
    expect(registry.scopeOf(late)).toBeNull();

    // A pop-up window belongs to its opener's project.
    const popup = page("window");
    registry.adopt(popup, first);
    expect(registry.scopeOf(popup)).toBe(projectA);
  });
});
