import { createFileRoute } from "@tanstack/react-router";

import { ExtensionsSettingsPanel } from "../components/settings/ExtensionsSettings";

function SettingsPluginsRoute() {
  return <ExtensionsSettingsPanel />;
}

export const Route = createFileRoute("/settings/plugins")({
  component: SettingsPluginsRoute,
});
