import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderSkill,
} from "@threadlines/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "~/environmentApi";

const PROVIDER_SKILLS_STALE_TIME_MS = 60_000;

export const providerSkillsQueryKeys = {
  project: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    providerInstanceId: ProviderInstanceId | null,
  ) => ["provider-skills", environmentId ?? null, cwd, providerInstanceId ?? null] as const,
};

export function providerSkillsQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  providerInstanceId: ProviderInstanceId | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: providerSkillsQueryKeys.project(
      input.environmentId,
      input.cwd,
      input.providerInstanceId,
    ),
    queryFn: async (): Promise<ServerProviderSkill[]> => {
      if (!input.environmentId || !input.cwd || !input.providerInstanceId) {
        throw new Error("Project skills are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      if (!api.providers) {
        throw new Error("This environment does not support project skill discovery.");
      }
      const inventory = await api.providers.getExtensions({
        cwd: input.cwd,
        providerInstanceId: input.providerInstanceId,
        includeMcpServers: false,
      });
      const provider = inventory.providers.find(
        (candidate) => candidate.instanceId === input.providerInstanceId,
      );
      if (!provider) {
        throw new Error("The selected provider did not return a project skill inventory.");
      }
      if (provider.status === "error") {
        throw new Error(provider.message || "Could not load project skills.");
      }
      return provider.skills.map(
        (skill): ServerProviderSkill => ({
          name: skill.name,
          path: skill.path,
          enabled: skill.enabled ?? true,
          ...(skill.displayName ? { displayName: skill.displayName } : {}),
          ...(skill.description ? { description: skill.description } : {}),
          ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
          ...(skill.scope ? { scope: skill.scope } : {}),
        }),
      );
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.providerInstanceId !== null,
    staleTime: input.staleTime ?? PROVIDER_SKILLS_STALE_TIME_MS,
    retry: 1,
  });
}
