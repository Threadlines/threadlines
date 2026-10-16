/**
 * Claude Code dynamic workflows are JavaScript scripts the agent writes. Each
 * one opens with a header that is a plain object literal:
 *
 *   export const meta = {
 *     name: "grok-build-provider-research",
 *     description: "Research how to add Grok Build as a provider",
 *     phases: [{ title: "Research", detail: "4 parallel streams" }],
 *   };
 *
 * The script is untrusted agent output, so `parseWorkflowScriptMeta` reads that
 * header without running anything: a small JavaScript lexer finds the
 * declaration, and a recursive-descent reader takes `name`, `description` and
 * `phases` from the literal. Every other key is skipped by bracket counting, so
 * functions, spreads and calls elsewhere in the header cost one property, not
 * the whole header. A header cut off mid-stream (the agent is still writing
 * it) yields whatever was complete.
 *
 * The work is linear in the input and bounded: only the first 64 Ki characters
 * are read, template literal nesting (the only recursion driven by the input)
 * stops at 16 levels, at most 50 phases are kept, and strings are cut at 2,000
 * characters. Malformed input never throws.
 */

export interface WorkflowScriptPhase {
  readonly title: string;
  readonly detail?: string;
}

export interface WorkflowScriptMeta {
  readonly name?: string;
  readonly description?: string;
  readonly phases: ReadonlyArray<WorkflowScriptPhase>;
}

const MAX_SCRIPT_CHARS = 64 * 1024;
const MAX_TEMPLATE_NESTING = 16;
const MAX_PHASES = 50;
const MAX_STRING_CHARS = 2_000;

type Token =
  | { readonly kind: "punct"; readonly char: string }
  | { readonly kind: "word"; readonly text: string }
  /** `value` is null when the literal cannot be read: interpolation, a bad escape, no closing quote. */
  | { readonly kind: "string"; readonly value: string | null }
  | { readonly kind: "number" }
  | { readonly kind: "regex" }
  | { readonly kind: "eof" };

const EOF_TOKEN: Token = { kind: "eof" };
const NUMBER_TOKEN: Token = { kind: "number" };
const REGEX_TOKEN: Token = { kind: "regex" };

/** Words after which a `/` starts a regular expression rather than a division. */
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const DECLARATION_KEYWORDS = new Set(["const", "let", "var"]);

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
]);

const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_CR = 0x0d;
const CHAR_SPACE = 0x20;
const CHAR_DOLLAR = 0x24;
const CHAR_QUOTE = 0x22;
const CHAR_APOSTROPHE = 0x27;
const CHAR_STAR = 0x2a;
const CHAR_DOT = 0x2e;
const CHAR_SLASH = 0x2f;
const CHAR_BACKSLASH = 0x5c;
const CHAR_BACKTICK = 0x60;
const CHAR_OPEN_BRACKET = 0x5b;
const CHAR_CLOSE_BRACKET = 0x5d;
const CHAR_OPEN_BRACE = 0x7b;
const CHAR_LINE_SEPARATOR = 0x2028;
const CHAR_PARAGRAPH_SEPARATOR = 0x2029;

function isLineTerminator(code: number): boolean {
  return (
    code === CHAR_LF ||
    code === CHAR_CR ||
    code === CHAR_LINE_SEPARATOR ||
    code === CHAR_PARAGRAPH_SEPARATOR
  );
}

function isWhitespace(code: number): boolean {
  return (
    (code >= CHAR_TAB && code <= CHAR_CR) ||
    code === CHAR_SPACE ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === CHAR_LINE_SEPARATOR ||
    code === CHAR_PARAGRAPH_SEPARATOR ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** Identifier characters, loosely: ASCII word characters, `$`, and anything non-ASCII that is not whitespace. */
function isIdentifierChar(code: number): boolean {
  return (
    isDigit(code) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === CHAR_DOLLAR ||
    (code >= 0x80 && !isWhitespace(code))
  );
}

function hexValue(text: string): number | null {
  if (text.length === 0) return null;
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    const digit = Number.parseInt(text.charAt(index), 16);
    if (Number.isNaN(digit)) return null;
    value = value * 16 + digit;
  }
  return value;
}

/**
 * A forgiving JavaScript tokenizer: enough to step over comments, strings,
 * template literals (with nested interpolations) and regular expressions
 * without being fooled by brackets or quotes inside them. Each character is
 * read once.
 */
class ScriptLexer {
  private readonly source: string;
  private pos = 0;
  private regexAllowed = true;
  private templateNesting = 0;

  constructor(source: string) {
    this.source = source;
    if (source.startsWith("#!")) this.skipLine();
  }

  next(): Token {
    const token = this.read();
    this.regexAllowed = allowsRegexAfter(token);
    return token;
  }

  private read(): Token {
    this.skipTrivia();
    const source = this.source;
    if (this.pos >= source.length) return EOF_TOKEN;
    const code = source.charCodeAt(this.pos);
    if (code === CHAR_QUOTE || code === CHAR_APOSTROPHE) return this.readQuoted(code);
    if (code === CHAR_BACKTICK) return this.readTemplate();
    if (isDigit(code) || (code === CHAR_DOT && isDigit(source.charCodeAt(this.pos + 1)))) {
      // Numbers are only stepped over, so a loose run of word characters is enough.
      while (this.pos < source.length) {
        const next = source.charCodeAt(this.pos);
        if (!isIdentifierChar(next) && next !== CHAR_DOT) break;
        this.pos += 1;
      }
      return NUMBER_TOKEN;
    }
    if (isIdentifierChar(code)) {
      const start = this.pos;
      while (this.pos < source.length && isIdentifierChar(source.charCodeAt(this.pos))) {
        this.pos += 1;
      }
      return { kind: "word", text: source.slice(start, this.pos) };
    }
    if (code === CHAR_SLASH && this.regexAllowed) return this.readRegex();
    this.pos += 1;
    return { kind: "punct", char: source.charAt(this.pos - 1) };
  }

  private skipTrivia(): void {
    const source = this.source;
    while (this.pos < source.length) {
      const code = source.charCodeAt(this.pos);
      if (isWhitespace(code)) {
        this.pos += 1;
        continue;
      }
      if (code !== CHAR_SLASH) return;
      const next = source.charCodeAt(this.pos + 1);
      if (next === CHAR_SLASH) {
        this.skipLine();
      } else if (next === CHAR_STAR) {
        const end = source.indexOf("*/", this.pos + 2);
        this.pos = end === -1 ? source.length : end + 2;
      } else {
        return;
      }
    }
  }

  private skipLine(): void {
    while (this.pos < this.source.length && !isLineTerminator(this.source.charCodeAt(this.pos))) {
      this.pos += 1;
    }
  }

  private readQuoted(quote: number): Token {
    const source = this.source;
    this.pos += 1;
    let value = "";
    let readable = true;
    let runStart = this.pos;
    while (this.pos < source.length) {
      const code = source.charCodeAt(this.pos);
      if (code === quote) {
        value += source.slice(runStart, this.pos);
        this.pos += 1;
        return { kind: "string", value: readable ? value : null };
      }
      if (code === CHAR_LF || code === CHAR_CR) break;
      if (code === CHAR_BACKSLASH) {
        value += source.slice(runStart, this.pos);
        const escaped = this.readEscape();
        if (escaped === null) readable = false;
        else value += escaped;
        runStart = this.pos;
        continue;
      }
      this.pos += 1;
    }
    // No closing quote on this line: not a string JavaScript would accept.
    return { kind: "string", value: null };
  }

  private readTemplate(): Token {
    const source = this.source;
    this.pos += 1;
    let value = "";
    let readable = true;
    let runStart = this.pos;
    while (this.pos < source.length) {
      const code = source.charCodeAt(this.pos);
      if (code === CHAR_BACKTICK) {
        value += source.slice(runStart, this.pos);
        this.pos += 1;
        return { kind: "string", value: readable ? value : null };
      }
      if (code === CHAR_BACKSLASH) {
        value += source.slice(runStart, this.pos);
        const escaped = this.readEscape();
        if (escaped === null) readable = false;
        else value += escaped;
        runStart = this.pos;
        continue;
      }
      if (code === CHAR_CR) {
        // Template literals read CR and CRLF as LF.
        value += `${source.slice(runStart, this.pos)}\n`;
        this.pos += source.charCodeAt(this.pos + 1) === CHAR_LF ? 2 : 1;
        runStart = this.pos;
        continue;
      }
      if (code === CHAR_DOLLAR && source.charCodeAt(this.pos + 1) === CHAR_OPEN_BRACE) {
        readable = false;
        this.pos += 2;
        this.skipInterpolation();
        runStart = this.pos;
        continue;
      }
      this.pos += 1;
    }
    return { kind: "string", value: null };
  }

  /**
   * Steps over a `${ ... }` expression, leaving `pos` after its closing brace.
   * Nesting past the limit gives up on the rest of the input.
   */
  private skipInterpolation(): void {
    if (this.templateNesting >= MAX_TEMPLATE_NESTING) {
      this.pos = this.source.length;
      return;
    }
    this.templateNesting += 1;
    this.regexAllowed = true;
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === "eof") break;
      if (token.kind !== "punct") continue;
      if (token.char === "{" || token.char === "(" || token.char === "[") {
        depth += 1;
      } else if (token.char === "}" || token.char === ")" || token.char === "]") {
        if (depth === 0 && token.char === "}") break;
        if (depth > 0) depth -= 1;
      }
    }
    this.templateNesting -= 1;
  }

  /** Reads the escape at `pos` (a backslash). Returns null when JavaScript would reject it. */
  private readEscape(): string | null {
    const source = this.source;
    const code = source.charCodeAt(this.pos + 1);
    if (Number.isNaN(code)) {
      this.pos += 1;
      return null;
    }
    const char = source.charAt(this.pos + 1);
    this.pos += 2;
    const simple = SIMPLE_ESCAPES.get(char);
    if (simple !== undefined) return simple;
    if (code === CHAR_CR) {
      if (source.charCodeAt(this.pos) === CHAR_LF) this.pos += 1;
      return "";
    }
    if (isLineTerminator(code)) return "";
    if (char === "0") return isDigit(source.charCodeAt(this.pos)) ? null : "\0";
    if (isDigit(code)) return null;
    if (char === "x") {
      const value = hexValue(source.slice(this.pos, this.pos + 2));
      if (value === null || this.pos + 2 > source.length) return null;
      this.pos += 2;
      return String.fromCharCode(value);
    }
    if (char === "u") {
      if (source.charCodeAt(this.pos) === CHAR_OPEN_BRACE) {
        // Six hex digits fit any code point. Looking no further keeps a run of
        // unclosed `\u{` escapes from rescanning the rest of the input.
        const close = source.slice(this.pos + 1, this.pos + 8).indexOf("}");
        if (close === -1) return null;
        const value = hexValue(source.slice(this.pos + 1, this.pos + 1 + close));
        if (value === null || value > 0x10ffff) return null;
        this.pos += close + 2;
        return String.fromCodePoint(value);
      }
      const value = hexValue(source.slice(this.pos, this.pos + 4));
      if (value === null || this.pos + 4 > source.length) return null;
      this.pos += 4;
      return String.fromCharCode(value);
    }
    return char;
  }

  private readRegex(): Token {
    const source = this.source;
    this.pos += 1;
    let inClass = false;
    while (this.pos < source.length) {
      const code = source.charCodeAt(this.pos);
      if (isLineTerminator(code)) break;
      if (code === CHAR_BACKSLASH) {
        this.pos += 2;
        continue;
      }
      this.pos += 1;
      if (inClass) {
        if (code === CHAR_CLOSE_BRACKET) inClass = false;
      } else if (code === CHAR_OPEN_BRACKET) {
        inClass = true;
      } else if (code === CHAR_SLASH) {
        while (this.pos < source.length && isIdentifierChar(source.charCodeAt(this.pos))) {
          this.pos += 1;
        }
        break;
      }
    }
    return REGEX_TOKEN;
  }
}

function allowsRegexAfter(token: Token): boolean {
  switch (token.kind) {
    case "punct":
      return token.char !== ")" && token.char !== "]" && token.char !== "}";
    case "word":
      return KEYWORDS_BEFORE_EXPRESSION.has(token.text);
    case "eof":
      return true;
    default:
      return false;
  }
}

function isPunct(token: Token, char: string): boolean {
  return token.kind === "punct" && token.char === char;
}

function endsValue(token: Token, closer: "}" | "]"): boolean {
  return token.kind === "eof" || isPunct(token, ",") || isPunct(token, closer);
}

/**
 * Advances to the first `const`/`let`/`var meta =` outside any bracket, so a
 * `meta` inside a comment, a string or a function body does not count.
 */
function findMetaInitializer(lexer: ScriptLexer): boolean {
  let depth = 0;
  let afterDeclaration = false;
  let afterName = false;
  for (;;) {
    const token = lexer.next();
    if (token.kind === "eof") return false;
    const declared = afterDeclaration;
    const named = afterName;
    afterDeclaration = false;
    afterName = false;
    if (named && isPunct(token, "=")) return true;
    if (token.kind === "word") {
      if (declared && token.text === "meta") afterName = true;
      else if (depth === 0 && DECLARATION_KEYWORDS.has(token.text)) afterDeclaration = true;
      continue;
    }
    if (token.kind !== "punct") continue;
    if (token.char === "{" || token.char === "(" || token.char === "[") {
      depth += 1;
    } else if ((token.char === "}" || token.char === ")" || token.char === "]") && depth > 0) {
      depth -= 1;
    }
  }
}

/**
 * Steps over one value of any shape by counting brackets, starting with
 * `first` when the caller already took it. Returns the token that ended it: a
 * `,` or the container's `closer` outside any bracket, or end of input.
 */
function skipValue(lexer: ScriptLexer, first: Token | null, closer: "}" | "]"): Token {
  let depth = 0;
  let token = first ?? lexer.next();
  for (;;) {
    if (token.kind === "eof") return token;
    if (token.kind === "punct") {
      const char = token.char;
      if (depth === 0 && (char === "," || char === closer)) return token;
      if (char === "{" || char === "(" || char === "[") depth += 1;
      else if ((char === "}" || char === ")" || char === "]") && depth > 0) depth -= 1;
    }
    token = lexer.next();
  }
}

function cleanString(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= MAX_STRING_CHARS) return trimmed;
  const lastKept = trimmed.charCodeAt(MAX_STRING_CHARS - 1);
  // Never end on the first half of a surrogate pair.
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? MAX_STRING_CHARS - 1 : MAX_STRING_CHARS;
  return trimmed.slice(0, end).trimEnd();
}

interface ValueResult<A> {
  readonly value: A | undefined;
  /** The `,`, closer or end of input that followed the value. */
  readonly terminator: Token;
}

/** A value that is exactly one readable string literal. */
function readStringValue(lexer: ScriptLexer, closer: "}" | "]"): ValueResult<string> {
  const token = lexer.next();
  if (token.kind !== "string") {
    return { value: undefined, terminator: skipValue(lexer, token, closer) };
  }
  const after = lexer.next();
  if (!endsValue(after, closer)) {
    // `"a" + b`, `"a".trim()`: an expression, not a literal.
    return { value: undefined, terminator: skipValue(lexer, after, closer) };
  }
  return { value: cleanString(token.value), terminator: after };
}

/**
 * Reads object properties after the opening `{`. Each `key: value` goes to
 * `readProperty`, which consumes the value and returns its terminator, or
 * returns null to have the value skipped. A shorthand or method property
 * calls `clearProperty`, since its value is not a literal. Returns false when
 * the input ended before the closing `}`.
 */
function readObjectBody(
  lexer: ScriptLexer,
  readProperty: (key: string) => Token | null,
  clearProperty: (key: string) => void,
): boolean {
  let token = lexer.next();
  for (;;) {
    if (isPunct(token, "}")) return true;
    if (token.kind === "eof") return false;
    if (isPunct(token, ",")) {
      token = lexer.next();
      continue;
    }
    let terminator: Token;
    const key = token.kind === "word" ? token.text : token.kind === "string" ? token.value : null;
    if (key === null) {
      // Spread, computed or numeric key: step over the whole property.
      terminator = skipValue(lexer, token, "}");
    } else {
      const next = lexer.next();
      if (isPunct(next, ":")) {
        terminator = readProperty(key) ?? skipValue(lexer, null, "}");
      } else {
        clearProperty(key);
        terminator = endsValue(next, "}") ? next : skipValue(lexer, next, "}");
      }
    }
    if (terminator.kind === "eof") return false;
    if (isPunct(terminator, "}")) return true;
    token = lexer.next();
  }
}

interface PhaseDraft {
  title?: string | undefined;
  detail?: string | undefined;
}

/** Reads one phase object after its `{`. Returns false at end of input. */
function readPhaseBody(lexer: ScriptLexer, phase: PhaseDraft): boolean {
  return readObjectBody(
    lexer,
    (key) => {
      if (key !== "title" && key !== "detail") return null;
      const { value, terminator } = readStringValue(lexer, "}");
      phase[key] = value;
      return terminator;
    },
    (key) => {
      if (key === "title" || key === "detail") phase[key] = undefined;
    },
  );
}

function toPhase(draft: PhaseDraft): WorkflowScriptPhase | null {
  if (draft.title === undefined) return null;
  return draft.detail === undefined
    ? { title: draft.title }
    : { title: draft.title, detail: draft.detail };
}

/**
 * Reads the phases array after its `[`, keeping phase objects with a title.
 * `complete` is false when the input ended inside the array.
 */
function readPhasesArray(lexer: ScriptLexer): {
  readonly phases: WorkflowScriptPhase[];
  readonly complete: boolean;
} {
  const phases: WorkflowScriptPhase[] = [];
  const keep = (draft: PhaseDraft) => {
    const phase = toPhase(draft);
    if (phase !== null && phases.length < MAX_PHASES) phases.push(phase);
  };
  let token = lexer.next();
  for (;;) {
    if (isPunct(token, "]")) return { phases, complete: true };
    if (token.kind === "eof") return { phases, complete: false };
    if (isPunct(token, ",")) {
      token = lexer.next();
      continue;
    }
    let terminator: Token;
    if (isPunct(token, "{")) {
      const draft: PhaseDraft = {};
      if (!readPhaseBody(lexer, draft)) {
        keep(draft);
        return { phases, complete: false };
      }
      const after = lexer.next();
      if (endsValue(after, "]")) {
        keep(draft);
        terminator = after;
      } else {
        terminator = skipValue(lexer, after, "]");
      }
    } else {
      terminator = skipValue(lexer, token, "]");
    }
    if (terminator.kind === "eof") return { phases, complete: false };
    if (isPunct(terminator, "]")) return { phases, complete: true };
    token = lexer.next();
  }
}

function readPhasesValue(lexer: ScriptLexer): ValueResult<ReadonlyArray<WorkflowScriptPhase>> {
  const token = lexer.next();
  if (!isPunct(token, "[")) {
    return { value: undefined, terminator: skipValue(lexer, token, "}") };
  }
  const { phases, complete } = readPhasesArray(lexer);
  if (!complete) return { value: phases, terminator: EOF_TOKEN };
  const after = lexer.next();
  if (!endsValue(after, "}")) {
    // `[...].filter(...)`: the runtime value may differ from the literal.
    return { value: undefined, terminator: skipValue(lexer, after, "}") };
  }
  return { value: phases, terminator: after };
}

/**
 * Reads `export const meta = { ... }` from a workflow script without running
 * it. Also accepts `const`, `let` and `var` without `export`. Returns null when
 * the script has no readable meta literal.
 */
export function parseWorkflowScriptMeta(script: string): WorkflowScriptMeta | null {
  const lexer = new ScriptLexer(script.slice(0, MAX_SCRIPT_CHARS));
  if (!findMetaInitializer(lexer)) return null;
  if (!isPunct(lexer.next(), "{")) return null;

  // Later duplicates win, as they would at runtime.
  const draft: MetaDraft = {};
  readObjectBody(
    lexer,
    (key) => {
      if (key === "name" || key === "description") {
        const { value, terminator } = readStringValue(lexer, "}");
        draft[key] = value;
        return terminator;
      }
      if (key === "phases") {
        const { value, terminator } = readPhasesValue(lexer);
        draft.phases = value;
        return terminator;
      }
      return null;
    },
    (key) => {
      if (key === "name" || key === "description" || key === "phases") draft[key] = undefined;
    },
  );

  return {
    ...(draft.name === undefined ? {} : { name: draft.name }),
    ...(draft.description === undefined ? {} : { description: draft.description }),
    phases: draft.phases ?? [],
  };
}

interface MetaDraft {
  name?: string | undefined;
  description?: string | undefined;
  phases?: ReadonlyArray<WorkflowScriptPhase> | undefined;
}

function isUpperCase(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

function isLowerCase(char: string): boolean {
  return char !== char.toUpperCase() && char === char.toLowerCase();
}

function isNameSeparator(char: string): boolean {
  return char === "-" || char === "_" || char.trim().length === 0;
}

/** Splits on `-`, `_` and whitespace. */
function splitOnSeparators(name: string): string[] {
  const words: string[] = [];
  let start = 0;
  for (let index = 0; index <= name.length; index += 1) {
    if (index === name.length || isNameSeparator(name.charAt(index))) {
      if (index > start) words.push(name.slice(start, index));
      start = index + 1;
    }
  }
  return words;
}

/** Splits camelCase and PascalCase, keeping acronyms whole: `parseHTTPResponse` -> parse, HTTP, Response. */
function splitCamelCase(name: string): string[] {
  const words: string[] = [];
  let start = 0;
  for (let index = 1; index < name.length; index += 1) {
    const previous = name.charAt(index - 1);
    const current = name.charAt(index);
    const startsWord =
      isUpperCase(current) && (!isUpperCase(previous) || isLowerCase(name.charAt(index + 1)));
    if (startsWord) {
      words.push(name.slice(start, index));
      start = index;
    }
  }
  words.push(name.slice(start));
  return words;
}

/**
 * Lowercases plain words and keeps words that carry their own casing:
 * acronyms (`HTTP`) and mixed case (`GitHub`, `iOS`).
 */
function normalizeWordCase(word: string): string {
  const rest = word.slice(1);
  return rest === rest.toLowerCase() ? word.toLowerCase() : word;
}

/**
 * Turns a workflow's machine name into a label: "grok-build-provider-research"
 * becomes "Grok build provider research". Handles kebab-case, snake_case and
 * camelCase. A name with nothing to split ("research") comes back as written,
 * trimmed.
 */
export function humanizeWorkflowName(name: string): string {
  const trimmed = name.trim();
  const separated = splitOnSeparators(trimmed);
  const hasSeparators = separated.length !== 1 || separated[0] !== trimmed;
  const words = hasSeparators ? separated : splitCamelCase(trimmed);
  if (words.length === 0 || (!hasSeparators && words.length === 1)) return trimmed;
  const [first = "", ...rest] = words.map(normalizeWordCase);
  const lead =
    first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
  return [lead, ...rest].join(" ");
}
