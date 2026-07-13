import type { ChatSkillReference, ServerProviderSkill } from "@threadlines/contracts";

import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

export function resolveComposerSkillReferences(
  prompt: string,
  skills: ReadonlyArray<ServerProviderSkill>,
): ChatSkillReference[] {
  const enabledSkillByName = new Map<string, ServerProviderSkill>();
  for (const skill of skills) {
    if (skill.enabled && !enabledSkillByName.has(skill.name)) {
      enabledSkillByName.set(skill.name, skill);
    }
  }

  const references: ChatSkillReference[] = [];
  const seen = new Set<string>();
  for (const segment of splitPromptIntoComposerSegments(prompt)) {
    if (segment.type !== "skill") continue;
    const skill = enabledSkillByName.get(segment.name);
    if (!skill) continue;
    const key = `${skill.name}\u0000${skill.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ name: skill.name, path: skill.path });
  }
  return references;
}
