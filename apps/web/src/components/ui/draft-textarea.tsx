"use client";

import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { Textarea, type TextareaProps } from "./textarea";

export type DraftTextareaProps = Omit<TextareaProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Multiline counterpart to `DraftInput`. Buffers keystrokes locally and calls
 * `onCommit` on blur. Enter inserts a newline instead of committing, so long
 * instructions can be written normally.
 */
export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
  const bag = useCommitOnBlur<HTMLTextAreaElement>(value, onCommit, { commitOnEnter: false });
  return <Textarea {...rest} {...bag} />;
}
