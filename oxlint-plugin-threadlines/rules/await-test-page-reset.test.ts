import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("threadlines/await-test-page-reset", { extension: "tsx" });

describe("threadlines/await-test-page-reset", () => {
  rule.valid(
    "allows an awaited reset",
    `
      import { afterEach } from "vite-plus/test";
      import { resetTestPage } from "~/lib/testPage.browser-harness";

      afterEach(async () => {
        localStorage.clear();
        await resetTestPage();
      });
    `,
  );

  rule.valid(
    "allows a reset the hook returns",
    `
      import { afterEach } from "vite-plus/test";
      import { resetTestPage } from "~/lib/testPage.browser-harness";

      afterEach(() => resetTestPage());
    `,
  );

  rule.invalid(
    "reports a reset nobody waits for",
    `
      import { afterEach } from "vite-plus/test";
      import { resetTestPage } from "~/lib/testPage.browser-harness";

      afterEach(() => {
        localStorage.clear();
        resetTestPage();
      });
    `,
  );
});
