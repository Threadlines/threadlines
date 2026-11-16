import { defineRule } from "@oxlint/plugins";

// `resetTestPage` (apps/web/src/lib/testPage.browser-harness.ts) unmounts the
// test's components, which is async, and then empties `document.body`. Called
// without awaiting it in an `afterEach`, the next test starts first: it renders,
// and the reset then empties the page under it, so the test waits on an empty
// page until it times out. It depends on timing, so it shows up as a test that
// fails now and then in CI (ThemeShareDialog, November 2026).
const RESET_FUNCTION = "resetTestPage";

const message =
  `Await \`${RESET_FUNCTION}()\` (or return it). Not awaited, it empties the page after the next ` +
  `test has started rendering, and that test fails depending on timing.`;

type AstNode = { readonly type: string; readonly parent?: AstNode | null };

/**
 * Whether the hook waits for the reset: walking out through the expression it
 * sits in (a \`.then\` chain, \`Promise.all([...])\`), it reaches an \`await\` or a
 * \`return\`, or it is the body of an arrow passed straight to a call
 * (\`afterEach(() => resetTestPage())\`). An arrow kept in a variable is not
 * enough: whoever calls it can still drop the promise.
 */
function isWaitedFor(call: AstNode): boolean {
  let child: AstNode = call;
  let parent = call.parent ?? null;
  while (parent) {
    if (parent.type === "AwaitExpression" || parent.type === "ReturnStatement") return true;
    if (parent.type === "ArrowFunctionExpression") {
      const arrow = parent as AstNode & { readonly body: AstNode };
      const caller = arrow.parent as (AstNode & { readonly arguments?: readonly AstNode[] }) | null;
      return (
        arrow.body === child &&
        caller?.type === "CallExpression" &&
        (caller.arguments ?? []).includes(arrow)
      );
    }
    if (
      parent.type.endsWith("Statement") ||
      parent.type.endsWith("Declaration") ||
      parent.type.endsWith("Declarator") ||
      parent.type === "FunctionExpression" ||
      parent.type === "Program" ||
      parent.type === "UnaryExpression"
    ) {
      return false;
    }
    child = parent;
    parent = parent.parent ?? null;
  }
  return false;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: `Require \`${RESET_FUNCTION}()\` to be awaited or returned, so the next browser test starts on an empty page.`,
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== RESET_FUNCTION) return;
        if (!isWaitedFor(node)) context.report({ node, message });
      },
    };
  },
});
