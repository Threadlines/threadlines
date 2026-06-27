import { definePlugin } from "@oxlint/plugins";

import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import preferTooltipProp from "./rules/prefer-tooltip-prop.ts";

export default definePlugin({
  meta: {
    name: "threadlines",
  },
  rules: {
    "no-inline-schema-compile": noInlineSchemaCompile,
    "prefer-tooltip-prop": preferTooltipProp,
  },
});
