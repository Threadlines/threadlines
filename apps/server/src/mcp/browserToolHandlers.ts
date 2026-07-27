/**
 * Every browser tool is the same two lines: find out which thread asked, and
 * hand the operation to the broker.
 *
 * That is the whole point of the split. The tools decide what the agent may ask
 * for and how it is described; the broker decides how a request reaches a page
 * and what happens when it cannot. Neither needs to know the other's problems,
 * and the handlers in between are thin enough to read in one go.
 */
import * as Effect from "effect/Effect";

import { BrowserToolkit } from "./browserTools.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../preview/PreviewAutomationBroker.ts";
import type { PreviewAutomationOperation } from "@threadlines/contracts";

const forward =
  (operation: PreviewAutomationOperation) =>
  (input: unknown): Effect.Effect<never, never, never> =>
    Effect.gen(function* () {
      const { threadId } = yield* McpInvocationContext;
      const broker = yield* PreviewAutomationBroker;
      return yield* broker.invoke({ threadId, operation, input });
    }) as Effect.Effect<never, never, never>;

export const BrowserToolkitHandlersLive = BrowserToolkit.toLayer({
  browser_snapshot: forward("snapshot"),
  browser_screenshot: forward("screenshot"),
  browser_status: forward("status"),
  browser_navigate: forward("navigate"),
  browser_click: forward("click"),
  browser_type: forward("type"),
  browser_press: forward("press"),
  browser_scroll: forward("scroll"),
  browser_wait_for: forward("waitFor"),
  browser_evaluate: forward("evaluate"),
  browser_resize: forward("resize"),
});
