import { CalendarClockIcon, WebhookIcon } from "lucide-react";

/**
 * The glyph beside a run's "Scheduled · <task>" or "Event · <task>" line: a
 * clock for a clock task's run, a webhook for an event task's.
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
