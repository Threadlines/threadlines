/**
 * Which project each in-app browser page belongs to.
 *
 * With sign-ins shared, one partition holds the pages of every project on an
 * environment, so the session no longer says whose a page is. Yet the sites a
 * page may visit, the certificates it may trust and how many tabs it may open
 * all belong to its project. So every page carries a scope: its project's own
 * partition name, whether or not it runs in that partition.
 *
 * A page gets its scope as it is created. The renderer names it on the
 * <webview>, `will-attach-webview` checks it against what the desktop handed
 * out (`expectGuest`), and Electron creates the guest synchronously right
 * after, inside that same call, which is when `web-contents-created` binds it.
 * Nothing about the page runs before then, so no navigation, redirect or
 * certificate question ever meets a page without one. A sign-in pop-up takes
 * its opener's (`adopt`).
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app, type WebContents } from "electron";

import { isPreviewPartition, isSharedPreviewPartition } from "./previewPartitions.ts";

export interface PreviewScopesShape {
  /** Records that pages of `scope` may run in the shared `partition`. */
  readonly issue: (partition: string, scope: string) => void;
  /**
   * Called from `will-attach-webview`: the scope the guest about to be created
   * will have, or null when the pair was never handed out and the guest must
   * not attach. A project's own partition is its own scope, named or not.
   */
  readonly expectGuest: (partition: string, scope: string | undefined) => string | null;
  /** A pop-up belongs to the project of the page that opened it. */
  readonly adopt: (contents: WebContents, opener: WebContents) => void;
  /** The project a page belongs to, or null for anything that is not a preview page. */
  readonly scopeOf: (contents: WebContents) => string | null;
}

export class PreviewScopes extends Context.Service<PreviewScopes, PreviewScopesShape>()(
  "@threadlines/desktop/preview/PreviewScopes",
) {}

/**
 * The registry itself, without Electron: `claim` is what the layer calls from
 * `web-contents-created` for every new page.
 */
export function makePreviewScopeRegistry(): PreviewScopesShape & {
  readonly claim: (contents: WebContents) => void;
} {
  const issued = new Map<string, Set<string>>();
  const bound = new WeakMap<WebContents, string>();
  /** The scope of the guest `will-attach-webview` just let through, until it is created. */
  let expected: { readonly scope: string } | null = null;

  const resolve = (partition: string, scope: string | undefined): string | null => {
    if (!isPreviewPartition(partition)) return null;
    if (isSharedPreviewPartition(partition)) {
      return scope !== undefined && issued.get(partition)?.has(scope) === true ? scope : null;
    }
    // A project's own partition, or the legacy shared one: the partition is
    // the only scope its pages can have.
    return scope === undefined || scope === partition ? partition : null;
  };

  const claim = (contents: WebContents) => {
    if (expected !== null && contents.getType() === "webview") {
      bound.set(contents, expected.scope);
      expected = null;
    }
  };

  return {
    claim,
    issue: (partition, scope) => {
      const scopes = issued.get(partition) ?? new Set<string>();
      scopes.add(scope);
      issued.set(partition, scopes);
    },
    expectGuest: (partition, scope) => {
      const resolved = resolve(partition, scope);
      if (resolved === null) {
        expected = null;
        return null;
      }
      const pending = { scope: resolved };
      expected = pending;
      // Electron creates the guest before this task ends. One that never
      // comes must not hand its scope to some later page.
      queueMicrotask(() => {
        if (expected === pending) expected = null;
      });
      return resolved;
    },
    adopt: (contents, opener) => {
      const scope = bound.get(opener);
      if (scope !== undefined) bound.set(contents, scope);
    },
    // Claims too, so a `web-contents-created` listener that asks about a new
    // page before the registry's own has run still gets the answer.
    scopeOf: (contents) => {
      if (!bound.has(contents)) claim(contents);
      return bound.get(contents) ?? null;
    },
  };
}

export const make = Effect.sync(function PreviewScopesMake(): PreviewScopesShape {
  const registry = makePreviewScopeRegistry();
  app.on("web-contents-created", (_event, contents) => registry.claim(contents));
  return registry;
});

export const layer = Layer.effect(PreviewScopes, make);
