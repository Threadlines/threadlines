export interface TerminalCommandInputState {
  readonly draft: string;
  readonly cursor: number;
}

export interface TerminalCommandInputResult {
  readonly state: TerminalCommandInputState;
  readonly submittedCommand: string | null;
}

const MAX_TRACKED_COMMAND_LENGTH = 2_048;
const MAX_SUBMITTED_COMMAND_LENGTH = 180;
const ESC = "\u001b";
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function createTerminalCommandInputState(): TerminalCommandInputState {
  return { draft: "", cursor: 0 };
}

export function normalizeSubmittedTerminalCommand(command: string): string | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized.length <= MAX_SUBMITTED_COMMAND_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SUBMITTED_COMMAND_LENGTH - 3)}...`;
}

function clampCursor(cursor: number, draft: string): number {
  return Math.max(0, Math.min(cursor, draft.length));
}

function insertText(draft: string, cursor: number, text: string): TerminalCommandInputState {
  if (text.length === 0) return { draft, cursor };
  const nextDraft = `${draft.slice(0, cursor)}${text}${draft.slice(cursor)}`.slice(
    0,
    MAX_TRACKED_COMMAND_LENGTH,
  );
  return {
    draft: nextDraft,
    cursor: clampCursor(cursor + text.length, nextDraft),
  };
}

function deleteBeforeCursor(draft: string, cursor: number): TerminalCommandInputState {
  if (cursor <= 0) return { draft, cursor: 0 };
  return {
    draft: `${draft.slice(0, cursor - 1)}${draft.slice(cursor)}`,
    cursor: cursor - 1,
  };
}

function deleteAtCursor(draft: string, cursor: number): TerminalCommandInputState {
  if (cursor >= draft.length) return { draft, cursor };
  return {
    draft: `${draft.slice(0, cursor)}${draft.slice(cursor + 1)}`,
    cursor,
  };
}

function moveWordLeft(draft: string, cursor: number): number {
  let nextCursor = clampCursor(cursor, draft);
  while (nextCursor > 0 && /\s/.test(draft[nextCursor - 1] ?? "")) nextCursor -= 1;
  while (nextCursor > 0 && !/\s/.test(draft[nextCursor - 1] ?? "")) nextCursor -= 1;
  return nextCursor;
}

function moveWordRight(draft: string, cursor: number): number {
  let nextCursor = clampCursor(cursor, draft);
  while (nextCursor < draft.length && !/\s/.test(draft[nextCursor] ?? "")) nextCursor += 1;
  while (nextCursor < draft.length && /\s/.test(draft[nextCursor] ?? "")) nextCursor += 1;
  return nextCursor;
}

function deleteWordBeforeCursor(draft: string, cursor: number): TerminalCommandInputState {
  const nextCursor = moveWordLeft(draft, cursor);
  return {
    draft: `${draft.slice(0, nextCursor)}${draft.slice(cursor)}`,
    cursor: nextCursor,
  };
}

function readEscapeSequence(data: string, index: number): string {
  if (data.startsWith(BRACKETED_PASTE_START, index)) return BRACKETED_PASTE_START;
  if (data.startsWith(BRACKETED_PASTE_END, index)) return BRACKETED_PASTE_END;

  const next = data[index + 1];
  if (next === "b" || next === "f") {
    return data.slice(index, index + 2);
  }

  if (next !== "[" && next !== "O") {
    return data.slice(index, Math.min(index + 2, data.length));
  }

  for (let end = index + 2; end < data.length; end += 1) {
    const code = data.charCodeAt(end);
    if (code >= 0x40 && code <= 0x7e) {
      return data.slice(index, end + 1);
    }
  }
  return data.slice(index);
}

function isCsiSequenceWithFinal(sequence: string, final: "C" | "D"): boolean {
  if (!sequence.startsWith(`${ESC}[`) || !sequence.endsWith(final)) {
    return false;
  }
  return /^[0-9;]*$/.test(sequence.slice(2, -1));
}

function applyEscapeSequence(
  state: TerminalCommandInputState,
  sequence: string,
): TerminalCommandInputState {
  if (sequence === `${ESC}b`) {
    return { ...state, cursor: moveWordLeft(state.draft, state.cursor) };
  }
  if (sequence === `${ESC}f`) {
    return { ...state, cursor: moveWordRight(state.draft, state.cursor) };
  }
  if (isCsiSequenceWithFinal(sequence, "D") || sequence === `${ESC}OD`) {
    return { ...state, cursor: clampCursor(state.cursor - 1, state.draft) };
  }
  if (isCsiSequenceWithFinal(sequence, "C") || sequence === `${ESC}OC`) {
    return { ...state, cursor: clampCursor(state.cursor + 1, state.draft) };
  }
  if (
    sequence === `${ESC}[H` ||
    sequence === `${ESC}OH` ||
    sequence === `${ESC}[1~` ||
    sequence === `${ESC}[7~`
  ) {
    return { ...state, cursor: 0 };
  }
  if (
    sequence === `${ESC}[F` ||
    sequence === `${ESC}OF` ||
    sequence === `${ESC}[4~` ||
    sequence === `${ESC}[8~`
  ) {
    return { ...state, cursor: state.draft.length };
  }
  if (sequence === `${ESC}[3~`) {
    return deleteAtCursor(state.draft, state.cursor);
  }
  return state;
}

export function applyTerminalInputData(
  state: TerminalCommandInputState,
  data: string,
): TerminalCommandInputResult {
  let nextState: TerminalCommandInputState = {
    draft: state.draft,
    cursor: clampCursor(state.cursor, state.draft),
  };
  let submittedCommand: string | null = null;

  for (let index = 0; index < data.length; ) {
    if (data.startsWith("\r\n", index)) {
      submittedCommand = normalizeSubmittedTerminalCommand(nextState.draft) ?? submittedCommand;
      nextState = createTerminalCommandInputState();
      index += 2;
      continue;
    }

    const codePoint = data.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);

    if (char === "\r" || char === "\n") {
      submittedCommand = normalizeSubmittedTerminalCommand(nextState.draft) ?? submittedCommand;
      nextState = createTerminalCommandInputState();
      index += char.length;
      continue;
    }

    if (char === ESC) {
      const sequence = readEscapeSequence(data, index);
      nextState = applyEscapeSequence(nextState, sequence);
      index += Math.max(sequence.length, char.length);
      continue;
    }

    switch (char) {
      case "\u0001":
        nextState = { ...nextState, cursor: 0 };
        break;
      case "\u0003":
        nextState = createTerminalCommandInputState();
        break;
      case "\u000c":
        break;
      case "\u0005":
        nextState = { ...nextState, cursor: nextState.draft.length };
        break;
      case "\u0008":
      case "\u007f":
        nextState = deleteBeforeCursor(nextState.draft, nextState.cursor);
        break;
      case "\u000b":
        nextState = {
          draft: nextState.draft.slice(0, nextState.cursor),
          cursor: nextState.cursor,
        };
        break;
      case "\u0015":
        nextState = {
          draft: nextState.draft.slice(nextState.cursor),
          cursor: 0,
        };
        break;
      case "\u0017":
        nextState = deleteWordBeforeCursor(nextState.draft, nextState.cursor);
        break;
      default:
        if (codePoint >= 0x20 && codePoint !== 0x7f) {
          nextState = insertText(nextState.draft, nextState.cursor, char);
        }
        break;
    }

    index += char.length;
  }

  return { state: nextState, submittedCommand };
}
