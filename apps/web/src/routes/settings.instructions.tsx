import { createFileRoute } from "@tanstack/react-router";

import { placeScopeSearch } from "../appPlaceLinks";
import { AgentInstructionsSettingsPanel } from "../components/settings/AgentInstructionsSettings";

export const Route = createFileRoute("/settings/instructions")({
  component: AgentInstructionsSettingsPanel,
  // `environment` and `project`: a place link opening the page on a thread's
  // project (appPlaceLinks).
  validateSearch: (search: Record<string, unknown>) => placeScopeSearch(search),
});
