import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderSkill } from "@threadlines/contracts";

import { resolveComposerSkillReferences } from "./providerSkillReferences";

function skill(name: string, enabled = true): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    enabled,
  };
}

describe("resolveComposerSkillReferences", () => {
  it("resolves selected skill markers to provider-native paths", () => {
    expect(
      resolveComposerSkillReferences("Use $skill-creator to help ", [
        skill("skill-creator"),
        skill("unrelated"),
      ]),
    ).toEqual([
      {
        name: "skill-creator",
        path: "/skills/skill-creator/SKILL.md",
      },
    ]);
  });

  it("deduplicates repeated markers and omits unavailable skills", () => {
    expect(
      resolveComposerSkillReferences("$review then use $review and $disabled ", [
        skill("review"),
        skill("disabled", false),
      ]),
    ).toEqual([{ name: "review", path: "/skills/review/SKILL.md" }]);
  });
});
