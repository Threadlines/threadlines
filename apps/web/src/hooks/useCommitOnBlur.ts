import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Buffer text input locally so keystrokes don't cause a settings-wide
 * re-render (and optionally a server RPC round-trip) on every character.
 * `onCommit` fires on blur, Enter, and focused unmount.
 *
 * The draft resynchronizes from the upstream `value` only when the input
 * is not focused, so an external push (e.g. an optimistic settings
 * update from the user's own commit, or a reset to defaults) doesn't
 * clobber an in-progress edit.
 *
 * Returns a bag of props that should be spread onto an `<Input>`:
 *
 *   const bag = useCommitOnBlur(instance.displayName ?? "", (next) => {...});
 *   <Input {...bag} placeholder="e.g. Work" />
 */
export function useCommitOnBlur(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const draftRef = useRef(draft);
  const valueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const lastCommitRef = useRef<{ readonly value: string; readonly draft: string } | null>(null);

  draftRef.current = draft;
  valueRef.current = value;
  onCommitRef.current = onCommit;

  const commitDraft = useCallback(() => {
    const nextDraft = draftRef.current;
    const currentValue = valueRef.current;
    if (nextDraft === currentValue) {
      return;
    }

    const lastCommit = lastCommitRef.current;
    if (lastCommit?.value === currentValue && lastCommit.draft === nextDraft) {
      return;
    }

    lastCommitRef.current = { value: currentValue, draft: nextDraft };
    onCommitRef.current(nextDraft);
  }, []);

  useEffect(() => {
    if (!focusedRef.current) {
      draftRef.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    return () => {
      if (focusedRef.current) {
        commitDraft();
      }
    };
  }, [commitDraft]);

  return {
    value: draft,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const nextDraft = event.target.value;
      draftRef.current = nextDraft;
      setDraft(nextDraft);
    },
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: () => {
      focusedRef.current = false;
      commitDraft();
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      }
    },
  };
}
