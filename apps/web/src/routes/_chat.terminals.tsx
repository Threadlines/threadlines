import { createFileRoute } from "@tanstack/react-router";

import { TerminalsPage } from "../components/terminals/TerminalsPage";
import { parseTerminalsSearch } from "../components/terminals/terminalsPage.logic";

export const Route = createFileRoute("/_chat/terminals")({
  validateSearch: (search: Record<string, unknown>) => parseTerminalsSearch(search),
  component: TerminalsPage,
});
