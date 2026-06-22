import type { ProviderInteractionMode } from "@threadlines/contracts";
import { HammerIcon, ListTodoIcon, type LucideIcon } from "lucide-react";

interface InteractionModePresentation {
  label: string;
  description: string;
  icon: LucideIcon;
}

export const interactionModeConfig: Record<ProviderInteractionMode, InteractionModePresentation> = {
  default: {
    label: "Build",
    description: "Build normally using the selected access level.",
    icon: HammerIcon,
  },
  plan: {
    label: "Plan",
    description: "Plan without editing files.",
    icon: ListTodoIcon,
  },
};

export const interactionModeOptions: ReadonlyArray<
  InteractionModePresentation & { mode: ProviderInteractionMode }
> = [
  { mode: "default", ...interactionModeConfig.default },
  { mode: "plan", ...interactionModeConfig.plan },
];

export function getInteractionModeToggleTitle(mode: ProviderInteractionMode): string {
  return mode === "plan"
    ? "Plan mode - click to return to normal build mode"
    : "Build mode - click to enter plan mode";
}
