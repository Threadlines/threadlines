import { definePlugin } from "@oxlint/plugins";

import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";

export default definePlugin({
  meta: {
    name: "threadlines",
  },
  rules: {
    "no-inline-schema-compile": noInlineSchemaCompile,
  },
});
