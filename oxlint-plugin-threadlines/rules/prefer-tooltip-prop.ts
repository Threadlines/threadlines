import { defineRule } from "@oxlint/plugins";

// Components that expose a styled `tooltip` prop (see apps/web ui/button.tsx,
// ui/toggle.tsx). Using the native `title` attribute on them renders an
// unstyled OS tooltip instead of the app's styled tooltip — the inconsistency
// this rule prevents. Bare DOM elements (`button`, `a`, `span`, ...) are left
// alone: `title` on truncated text is a legitimate native-tooltip use, and
// bare interactive elements can opt in with the `TooltipWrapper` helper.
const COMPONENTS_WITH_TOOLTIP_PROP = new Set(["Button", "Toggle"]);

const message = (componentName: string) =>
  `Use the \`tooltip\` prop instead of the native \`title\` attribute on <${componentName}>. ` +
  `\`title\` renders an unstyled OS tooltip; the \`tooltip\` prop uses the app's styled tooltip.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the native `title` attribute on components that expose a styled `tooltip` prop (Button, Toggle); use `tooltip` so tooltips match the app's styling.",
    },
  },
  createOnce(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const componentName = node.name.name;
        if (!COMPONENTS_WITH_TOOLTIP_PROP.has(componentName)) return;

        for (const attribute of node.attributes) {
          if (
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === "title"
          ) {
            context.report({
              node: attribute,
              message: message(componentName),
            });
          }
        }
      },
    };
  },
});
