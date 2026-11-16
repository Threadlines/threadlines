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
        const parent = node.parent;
        if (
          parent?.type === "AwaitExpression" ||
          parent?.type === "ReturnStatement" ||
          (parent?.type === "ArrowFunctionExpression" && parent.body === node)
        ) {
          return;
        }
        context.report({ node, message });
      },
    };
  },
});
