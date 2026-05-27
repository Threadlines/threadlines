import { createFileRoute } from "@tanstack/react-router";

import { AgentInstructionsSettingsPanel } from "../components/settings/AgentInstructionsSettings";

export const Route = createFileRoute("/settings/instructions")({
  component: AgentInstructionsSettingsPanel,
});
