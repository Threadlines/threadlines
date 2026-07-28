/**
 * A key, as CDP wants to hear about it.
 *
 * `Input.dispatchKeyEvent` will not infer any of this: send it `key: "a"` alone
 * and the page sees a keydown but no character, because insertion comes from
 * `text` and shortcut handlers read `code` and `windowsVirtualKeyCode`. Getting
 * one of the three wrong produces a key press that half works, which is worse
 * to debug than one that does not work at all.
 *
 * Out here rather than inline because it is pure and entirely table-driven --
 * the sort of thing that is wrong in one entry and right in twenty, which a
 * test catches and reading does not.
 */
export type PreviewKeyModifier = "Alt" | "Control" | "Meta" | "Shift";

export interface CdpKeyDefinition {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly text?: string;
}

const NAMED_KEYS: Readonly<Record<string, CdpKeyDefinition>> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
};

const PUNCTUATION_KEYS: Readonly<Record<string, readonly [code: string, virtualKeyCode: number]>> =
  {
    ";": ["Semicolon", 186],
    ":": ["Semicolon", 186],
    "=": ["Equal", 187],
    "+": ["Equal", 187],
    ",": ["Comma", 188],
    "<": ["Comma", 188],
    "-": ["Minus", 189],
    _: ["Minus", 189],
    ".": ["Period", 190],
    ">": ["Period", 190],
    "/": ["Slash", 191],
    "?": ["Slash", 191],
    "`": ["Backquote", 192],
    "~": ["Backquote", 192],
    "[": ["BracketLeft", 219],
    "{": ["BracketLeft", 219],
    "\\": ["Backslash", 220],
    "|": ["Backslash", 220],
    "]": ["BracketRight", 221],
    "}": ["BracketRight", 221],
    "'": ["Quote", 222],
    '"': ["Quote", 222],
  };

const SHIFTED_DIGITS: Readonly<Record<string, string>> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
};

export function toCdpModifierBitmask(modifiers: ReadonlyArray<PreviewKeyModifier> = []): number {
  let bitmask = 0;
  for (const modifier of modifiers) {
    bitmask |= modifier === "Alt" ? 1 : modifier === "Control" ? 2 : modifier === "Meta" ? 4 : 8;
  }
  return bitmask;
}

export function toCdpKeyDefinition(key: string): CdpKeyDefinition {
  const named = NAMED_KEYS[key];
  if (named !== undefined) {
    return named;
  }

  if (key.length !== 1) {
    return { key, code: key, windowsVirtualKeyCode: 0 };
  }

  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: key,
    };
  }

  const digit = SHIFTED_DIGITS[key] ?? key;
  if (/^[0-9]$/.test(digit)) {
    return {
      key,
      code: `Digit${digit}`,
      windowsVirtualKeyCode: digit.charCodeAt(0),
      text: key,
    };
  }

  if (key === " ") {
    return { key, code: "Space", windowsVirtualKeyCode: 32, text: key };
  }

  const punctuation = PUNCTUATION_KEYS[key];
  if (punctuation !== undefined) {
    return {
      key,
      code: punctuation[0],
      windowsVirtualKeyCode: punctuation[1],
      text: key,
    };
  }

  return { key, code: "", windowsVirtualKeyCode: key.charCodeAt(0), text: key };
}
