import { createFileRoute, redirect } from "@tanstack/react-router";

import { AgentSetupScreen } from "../components/setup/AgentSetupScreen";
import { parseSetupStep, type SetupStep } from "../components/setup/agentSetup.logic";

function SetupRouteView() {
  const { step } = Route.useSearch();
  return <AgentSetupScreen routeStep={step ?? null} />;
}

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  validateSearch: (search: Record<string, unknown>): { step?: SetupStep } => {
    const step = parseSetupStep(search.step);
    return step ? { step } : {};
  },
  component: SetupRouteView,
});
