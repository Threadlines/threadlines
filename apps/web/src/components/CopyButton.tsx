import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { failureNotice, toastManager } from "./ui/toast";

/** Copies, and raises a failure notice when the copy doesn't land. */
function useCopyWithFailureNotice(what: string) {
  return useCopyToClipboard({
    onError: (error) => {
      toastManager.add(failureNotice({ title: `Couldn't copy the ${what}`, error }));
    },
  });
}

/**
 * A solid Copy button for one value (an address, a command, a secret) in a
 * settings row or a panel; says Copied for a moment after. `label` names
 * what it copies for screen readers.
 */
export function CopyButton({
  value,
  label,
  testId,
}: {
  readonly value: string;
  readonly label: string;
  readonly testId?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyWithFailureNotice("value");
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-label={label}
      data-testid={testId}
      onClick={() => copyToClipboard(value, undefined)}
    >
      {isCopied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * Any Button that copies and stays on screen: its icon (a copy glyph unless
 * `icon` says otherwise) turns into a check for a moment, so the copy needs no
 * notice; a failed copy still raises one. `what` names the thing for that
 * failure, in lowercase ("update command"). Works as a tooltip trigger's
 * `render`: the trigger's props pass through to the Button.
 */
export function CopyIconButton({
  value,
  what,
  icon: Icon = CopyIcon,
  iconClassName = "size-3",
  onClick,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  readonly value: string;
  readonly what: string;
  readonly icon?: LucideIcon;
  readonly iconClassName?: string;
  readonly children?: ReactNode;
}) {
  const { copyToClipboard, isCopied } = useCopyWithFailureNotice(what);
  return (
    <Button
      {...props}
      onClick={(event) => {
        onClick?.(event);
        copyToClipboard(value, undefined);
      }}
    >
      {isCopied ? (
        <CheckIcon className={cn(iconClassName, "text-success")} aria-hidden />
      ) : (
        <Icon className={iconClassName} aria-hidden />
      )}
      {children}
    </Button>
  );
}
