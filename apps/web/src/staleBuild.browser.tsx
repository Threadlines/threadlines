import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isStaleBuildError } from "./staleBuild";

describe("isStaleBuildError", () => {
  it("recognises a missing build file however the browser words it", () => {
    const chunk = "https://nightly.app.threadlines.dev/assets/_chat-Ba9ttbgo.js";
    for (const message of [
      // iOS (Chrome and Safari) when the host answers with its app page.
      `'text/html' is not a valid JavaScript MIME type for module script '${chunk}'.`,
      "Importing a module script failed.",
      `Failed to fetch dynamically imported module: ${chunk}`,
      `error loading dynamically imported module: ${chunk}`,
      "Unable to preload CSS for /assets/_chat-Ba9ttbgo.css",
    ]) {
      expect(isStaleBuildError(new TypeError(message)), message).toBe(true);
    }
    expect(isStaleBuildError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleBuildError("Importing a module script failed.")).toBe(false);
  });
});

describe("resolveStaleBuildRecovery", () => {
  const RELOADS_KEY = "threadlines:stale-build-reloads";
  /** The entry script the server's page names now; null while it can't be reached. */
  let servedBuild: string | null = null;
  let pageLoads = 0;

  /**
   * A fresh page load running `build`: a new module instance (its reload
   * claim resets) under a page whose first module script names that build.
   * Scripts added as markup never run, so this changes nothing else.
   */
  async function loadPage(build: string) {
    document.querySelector("script[data-test-build]")?.remove();
    document.head.insertAdjacentHTML(
      "afterbegin",
      `<script type="module" data-test-build src="${build}"></script>`,
    );
    pageLoads += 1;
    // Browser mode keeps one module registry, so a query makes a new instance.
    return (await import(
      /* @vite-ignore */ `./staleBuild.ts?page=${pageLoads}`
    )) as typeof import("./staleBuild");
  }

  beforeEach(() => {
    sessionStorage.removeItem(RELOADS_KEY);
    servedBuild = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (servedBuild === null) {
          throw new TypeError("Load failed");
        }
        return new Response(
          `<!doctype html><html><head><script type="module" crossorigin src="${servedBuild}"></script></head></html>`,
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelector("script[data-test-build]")?.remove();
    sessionStorage.removeItem(RELOADS_KEY);
  });

  it("reloads into each deploy, and never loops on a failure a reload can't fix", async () => {
    servedBuild = "/assets/index-B.js";
    const stalePage = await loadPage("/assets/index-A.js");
    expect(await stalePage.resolveStaleBuildRecovery()).toBe("reload");
    // A render may ask twice; the page still has its one reload.
    expect(await stalePage.resolveStaleBuildRecovery()).toBe("reload");

    // The new build fails too: one more try, then the user decides.
    expect(await (await loadPage("/assets/index-B.js")).resolveStaleBuildRecovery()).toBe("reload");
    expect(await (await loadPage("/assets/index-B.js")).resolveStaleBuildRecovery()).toBe(
      "leave-to-user",
    );

    // A host swapping between two builds stops once a move repeats.
    servedBuild = "/assets/index-A.js";
    expect(await (await loadPage("/assets/index-B.js")).resolveStaleBuildRecovery()).toBe("reload");
    servedBuild = "/assets/index-B.js";
    expect(await (await loadPage("/assets/index-A.js")).resolveStaleBuildRecovery()).toBe(
      "leave-to-user",
    );

    // The next deploy still gets its reload.
    servedBuild = "/assets/index-C.js";
    expect(await (await loadPage("/assets/index-B.js")).resolveStaleBuildRecovery()).toBe("reload");
  });

  it("waits while the app can't be reached, without spending the reload", async () => {
    const page = await loadPage("/assets/index-A.js");
    expect(await page.resolveStaleBuildRecovery()).toBe("unreachable");

    servedBuild = "/assets/index-B.js";
    expect(await page.resolveStaleBuildRecovery()).toBe("reload");
    // A yes already given still waits for the app to answer.
    servedBuild = null;
    expect(await page.resolveStaleBuildRecovery()).toBe("unreachable");
  });
});
