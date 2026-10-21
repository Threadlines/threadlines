import { createFileRoute } from "@tanstack/react-router";

import { ScheduledView } from "../components/scheduled/ScheduledView";
import { parseScheduledSearch } from "../components/scheduled/scheduled.logic";

export const Route = createFileRoute("/_chat/scheduled")({
  validateSearch: (search: Record<string, unknown>) => parseScheduledSearch(search),
  component: ScheduledView,
});
