import { createFileRoute } from "@tanstack/react-router";

import { ExtensionsSettingsPanel } from "../components/settings/ExtensionsSettings";

function SettingsExtensionsRoute() {
  return <ExtensionsSettingsPanel />;
}

export const Route = createFileRoute("/settings/extensions")({
  component: SettingsExtensionsRoute,
});
