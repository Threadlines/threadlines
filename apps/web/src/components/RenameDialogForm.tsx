/**
 * What every Rename dialog shows (a thread, a computer, a device): one name
 * field, Save and Cancel, and the save's error inline. Saving the name as it
 * was just closes. Render it inside an open `Dialog`.
 */
import { type ReactNode, useState } from "react";

import { Button } from "./ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export function RenameDialogForm({
  title,
  description,
  inputLabel,
  initialValue,
  placeholder,
  hint,
  allowEmpty = false,
  maxLength,
  failure,
  testId,
  onSave,
  onClose,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  /** The field's accessible name ("Thread name"). */
  readonly inputLabel: string;
  readonly initialValue: string;
  readonly placeholder?: string;
  /** One line under the field. */
  readonly hint?: ReactNode;
  /** An empty name can be saved: the caller reads it as "back to the default". */
  readonly allowEmpty?: boolean;
  readonly maxLength?: number;
  /** The error shown when a save fails without a message of its own. */
  readonly failure: string;
  /** `<testId>-dialog`, `-input` and `-save`. */
  readonly testId: string;
  /** Saves the trimmed name; throws to show its message. Closes the dialog itself. */
  readonly onSave: (name: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const canSave = (allowEmpty || trimmed.length > 0) && !saving;

  const save = async () => {
    if (!canSave) return;
    if (trimmed === initialValue.trim()) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (cause) {
      setSaving(false);
      setError(cause instanceof Error && cause.message.length > 0 ? cause.message : failure);
    }
  };

  return (
    <DialogPopup className="max-w-md" data-testid={`${testId}-dialog`}>
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <Input
            aria-label={inputLabel}
            data-testid={`${testId}-input`}
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave} data-testid={`${testId}-save`}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
