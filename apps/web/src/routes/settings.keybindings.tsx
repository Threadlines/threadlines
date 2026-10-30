import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettingsPanel } from "../components/settings/KeybindingsSettings";

export const Route = createFileRoute("/settings/keybindings")({
  component: KeybindingsSettingsPanel,
  // `q`: a settings search result opening the table filtered to its shortcut;
  // `n` numbers each opening, so opening the same one again filters again.
  validateSearch: (search: Record<string, unknown>): { q?: string; n?: number } => ({
    ...(typeof search["q"] === "string" && search["q"].length > 0 ? { q: search["q"] } : {}),
    ...(Number.isFinite(Number(search["n"])) ? { n: Number(search["n"]) } : {}),
  }),
});
