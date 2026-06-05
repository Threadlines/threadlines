import { cn } from "~/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "animate-skeleton rounded-sm bg-muted [--skeleton-highlight:--alpha(var(--color-white)/64%)] [background-image:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)] [background-position:100%_0] [background-size:200%_100%] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
