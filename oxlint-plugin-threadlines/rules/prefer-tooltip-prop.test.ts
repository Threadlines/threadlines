import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("threadlines/prefer-tooltip-prop", { extension: "tsx" });

describe("threadlines/prefer-tooltip-prop", () => {
  rule.valid(
    "allows the tooltip prop on Button",
    `
      import { Button } from "~/components/ui/button";

      export const ok = <Button tooltip="Revert to this message">Revert</Button>;
    `,
  );

  rule.valid(
    "allows the tooltip prop on Toggle",
    `
      import { Toggle } from "~/components/ui/toggle";

      export const ok = <Toggle tooltip="Hide whitespace changes">Whitespace</Toggle>;
    `,
  );

  rule.valid(
    "leaves the native title attribute on non-tooltip elements (truncated text)",
    `
      export const ok = <span title="apps/web/src/components/DiffPanel.tsx">DiffPanel.tsx</span>;
    `,
  );

  rule.valid(
    "leaves the native title attribute on bare interactive elements",
    `
      export const ok = <button title="Back to source control">Back</button>;
    `,
  );

  rule.invalid(
    "reports the native title attribute on Button",
    `
      import { Button } from "~/components/ui/button";

      export const bad = <Button title="Revert to this message">Revert</Button>;
    `,
  );

  rule.invalid(
    "reports the native title attribute on Toggle",
    `
      import { Toggle } from "~/components/ui/toggle";

      export const bad = <Toggle title="Hide whitespace changes">Whitespace</Toggle>;
    `,
  );
});
