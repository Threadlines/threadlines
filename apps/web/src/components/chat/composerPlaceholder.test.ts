import { describe, expect, it } from "vite-plus/test";

import { buildDefaultComposerPlaceholder } from "./composerPlaceholder";

describe("buildDefaultComposerPlaceholder", () => {
  it("advertises every loaded composer capability", () => {
    expect(
      buildDefaultComposerPlaceholder({
        canReferenceFiles: true,
        canInvokeSkills: true,
      }),
    ).toBe("Ask anything — @ reference files, $ invoke skills, / commands");
  });

  it("omits unavailable project capabilities", () => {
    expect(
      buildDefaultComposerPlaceholder({
        canReferenceFiles: false,
        canInvokeSkills: false,
      }),
    ).toBe("Ask anything — / commands");
  });

  it("keeps provider skills available without project file references", () => {
    expect(
      buildDefaultComposerPlaceholder({
        canReferenceFiles: false,
        canInvokeSkills: true,
      }),
    ).toBe("Ask anything — $ invoke skills, / commands");
  });
});
