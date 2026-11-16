import { definePlugin } from "@oxlint/plugins";

import awaitTestPageReset from "./rules/await-test-page-reset.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import preferTooltipProp from "./rules/prefer-tooltip-prop.ts";

export default definePlugin({
  meta: {
    name: "threadlines",
  },
  rules: {
    "await-test-page-reset": awaitTestPageReset,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "prefer-tooltip-prop": preferTooltipProp,
  },
});
