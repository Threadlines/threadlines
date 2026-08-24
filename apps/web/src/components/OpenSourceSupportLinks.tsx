import { HeartIcon, StarIcon } from "lucide-react";

import { riseDelay } from "./ThreadlinesFigure";

interface OpenSourceSupportLinksProps {
  delay?: string;
}

/** Quiet repository links shared by the app's everyday empty states. */
export function OpenSourceSupportLinks({ delay = "0.34s" }: OpenSourceSupportLinksProps) {
  return (
    <div
      className="no-thread-rise mt-12 flex items-center justify-center gap-6"
      style={riseDelay(delay)}
    >
      <a
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground"
        href="https://github.com/Threadlines/threadlines"
        target="_blank"
        rel="noopener noreferrer"
      >
        <StarIcon className="size-3.5" />
        Star on GitHub
      </a>
      <a
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground"
        href="https://github.com/sponsors/Threadlines"
        target="_blank"
        rel="noopener noreferrer"
      >
        <HeartIcon className="size-3.5" />
        Sponsor
      </a>
    </div>
  );
}
