import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "./ui/button";

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
  const { copyToClipboard, isCopied } = useCopyToClipboard();
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
