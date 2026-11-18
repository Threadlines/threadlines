import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

import {
  MAX_COMMANDS_SECRET_BYTES,
  MAX_ENV_SECRET_LENGTH,
  checkSecretValue,
  envFilePathProblem,
  hasEdgeWhitespace,
  posixShellQuote,
  scanEnvFile,
  secretAnswerMessageId,
  secretNameProblem,
  secretRequestIdOfAnswerMessage,
  withoutEdgeWhitespace,
  writeEnvLine,
} from "./secretRequests.ts";

const envFile = { kind: "env_file", path: ".env.local" } as const;
const commands = { kind: "commands" } as const;
const multiline = { kind: "commands", multiline: true } as const;

/** The written text, or the refusal's words. */
const written = (result: ReturnType<typeof checkSecretValue>) =>
  result.ok ? result.written : { refused: result.detail };
const write = (text: string, value = "new") => {
  const result = writeEnvLine(text, "API_KEY", value, ".env.local");
  return result.ok ? result.text : { refused: result.detail };
};

describe("secret names", () => {
  it("takes a variable name and refuses one a framework ships to browsers, in any case", () => {
    expect(secretNameProblem("STRIPE_SECRET_KEY")).toBeNull();
    expect(secretNameProblem("1PASSWORD_TOKEN")).toContain("not starting with a digit");
    for (const name of ["VITE_API_KEY", "next_public_stripe_key", "Expo_Public_Token"]) {
      expect(secretNameProblem(name)).toContain("sent to browsers");
    }
  });
});

describe("env file paths", () => {
  it("takes a relative .env file or .dev.vars and refuses anything else", () => {
    for (const path of [".env.local", "config/.env", ".dev.vars"]) {
      expect(envFilePathProblem(path)).toBeNull();
    }
    expect(envFilePathProblem("/repo/.env")).toContain("relative");
    expect(envFilePathProblem("C:\\repo\\.env")).toContain("relative");
    expect(envFilePathProblem("app/../../.env")).toContain("inside this thread's folder");
    expect(envFilePathProblem("notes.txt")).toContain("must be .env");
    // Templates are usually committed.
    expect(envFilePathProblem(".env.example")).toContain("template");
    expect(envFilePathProblem(".env.local.template")).toContain("template");
  });
});

describe("secret values", () => {
  it("writes an env value bare when it can, quoted otherwise, and never trims", () => {
    expect(written(checkSecretValue(envFile, "sk_live-AbC/12+3=="))).toBe("sk_live-AbC/12+3==");
    expect(written(checkSecretValue(envFile, "two words"))).toBe("'two words'");
    expect(written(checkSecretValue(envFile, "abc#def"))).toBe("'abc#def'");
    expect(written(checkSecretValue(envFile, "pa$$word"))).toBe("'pa$$word'");
    expect(written(checkSecretValue(envFile, " leading"))).toBe("' leading'");
    expect(written(checkSecretValue(envFile, "x".repeat(MAX_ENV_SECRET_LENGTH)))).toHaveLength(
      MAX_ENV_SECRET_LENGTH,
    );
  });

  it("refuses an env value a single-quoted line can't hold", () => {
    for (const value of ["it's", "line\nbreak", "line\r\nbreak", ""]) {
      expect(written(checkSecretValue(envFile, value))).toMatchObject({
        refused: expect.any(String),
      });
    }
    expect(written(checkSecretValue(envFile, "x".repeat(MAX_ENV_SECRET_LENGTH + 1)))).toEqual({
      refused: `An env file line takes at most ${MAX_ENV_SECRET_LENGTH} characters.`,
    });
  });

  it("keeps a key for commands as typed, with LF line endings only when it is multi-line", () => {
    expect(written(checkSecretValue(commands, " it's $x "))).toBe(" it's $x ");
    expect(written(checkSecretValue(commands, "a\nb"))).toMatchObject({
      refused: expect.stringContaining("line break"),
    });
    expect(written(checkSecretValue(multiline, "-----BEGIN\r\nkey\rbody\n-----END"))).toBe(
      "-----BEGIN\nkey\nbody\n-----END",
    );
    // The limit counts UTF-8 bytes, not characters.
    const wide = "é".repeat(MAX_COMMANDS_SECRET_BYTES / 2 + 1);
    expect(wide.length).toBeLessThan(MAX_COMMANDS_SECRET_BYTES);
    expect(written(checkSecretValue(commands, wide))).toEqual({
      refused: "A key for commands can be at most 64 KB.",
    });
  });
});

describe("env file edits", () => {
  it("appends a line, adding the missing line break first", () => {
    expect(write("")).toBe("API_KEY=new\n");
    expect(write("OTHER=1")).toBe("OTHER=1\nAPI_KEY=new\n");
    expect(write("OTHER=1\r\n")).toBe("OTHER=1\r\nAPI_KEY=new\r\n");
  });

  it("replaces the one line in place, keeping its indent, export and line ending", () => {
    expect(write("A=1\n  export API_KEY = old # note\nB=2\n")).toBe(
      "A=1\n  export API_KEY=new\nB=2\n",
    );
    expect(write("A=1\r\nAPI_KEY=old\r\nB=2\r\n")).toBe("A=1\r\nAPI_KEY=new\r\nB=2\r\n");
  });

  it("skips lines inside another value's multi-line quote", () => {
    const text = 'CERT="-----BEGIN\nAPI_KEY=inside\n-----END"\nAPI_KEY=old\n';
    expect(scanEnvFile(text, "API_KEY", ".env.local")).toEqual({ ok: true, line: 3 });
    expect(write(text)).toBe('CERT="-----BEGIN\nAPI_KEY=inside\n-----END"\nAPI_KEY=new\n');
    // An escaped quote on a later line doesn't end the value.
    const json = 'JSON="{\n  \\"a\\": 1,\nAPI_KEY=inside\n}"\n';
    expect(scanEnvFile(json, "API_KEY", ".env.local")).toEqual({ ok: true, line: null });
    expect(write(json)).toBe(`${json}API_KEY=new\n`);
  });

  it("refuses a file it can't edit safely", () => {
    expect(write("API_KEY=a\nexport API_KEY=b\n")).toMatchObject({
      refused: expect.stringContaining("more than once"),
    });
    expect(write('API_KEY="first\nsecond"\n')).toMatchObject({
      refused: expect.stringContaining("spans more than one line"),
    });
    expect(write("API_KEY=old\nCERT='-----BEGIN\n")).toMatchObject({
      refused: expect.stringContaining("never closes"),
    });
  });
});

describe("edge whitespace", () => {
  it("counts a pasted PEM's closing line break as part of a multi-line key, not as a stray space", () => {
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";
    expect(hasEdgeWhitespace(pem, true)).toBe(false);
    expect(hasEdgeWhitespace(` ${pem}`, true)).toBe(true);
    expect(withoutEdgeWhitespace(`  ${pem.replace(/\n$/, "  \n")}`, true)).toBe(pem);
    expect(hasEdgeWhitespace("sk_test_1\n")).toBe(true);
    expect(withoutEdgeWhitespace(" sk_test_1 ")).toBe("sk_test_1");
  });
});

describe("shell quoting", () => {
  it.skipIf(process.platform === "win32")(
    "quotes a path with a quote and a space so sh reads it back unchanged",
    () => {
      const path = "/Users/o'brien/My Keys/$HOME/value";
      expect(
        execFileSync("sh", ["-c", `printf %s ${posixShellQuote(path)}`], { encoding: "utf8" }),
      ).toBe(path);
    },
  );
});

describe("secret answer messages", () => {
  it("names its request, and no other message names one", () => {
    expect(secretRequestIdOfAnswerMessage(secretAnswerMessageId("request-1"))).toBe("request-1");
    expect(secretRequestIdOfAnswerMessage("secret-answer:")).toBeNull();
    expect(secretRequestIdOfAnswerMessage("command-output:run-1")).toBeNull();
  });
});
