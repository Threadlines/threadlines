import { CalendarClockIcon, WebhookIcon } from "lucide-react";

/**
 * A scheduled task's run, as a glyph: a clock for a clock task's run, a
 * webhook for an event task's. It marks the run after the project name on its
 * sidebar row, and leads its "Scheduled · <task>" or "Event · <task>" line.
 */
export function ScheduledRunIcon({
  event,
  className,
}: {
  readonly event: boolean;
  readonly className?: string;
}) {
  const Icon = event ? WebhookIcon : CalendarClockIcon;
  return <Icon aria-hidden className={className} />;
}
