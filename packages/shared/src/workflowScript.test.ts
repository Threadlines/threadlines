import { describe, expect, it } from "vite-plus/test";

import { humanizeWorkflowName, parseWorkflowScriptMeta } from "./workflowScript.ts";

describe("parseWorkflowScriptMeta", () => {
  it("reads the header of a workflow script", () => {
    const script = `export const meta = {
  name: 'grok-build-provider-research',
  description: 'Research how to add Grok Build as a first-class provider',
  phases: [
    { title: 'Research', detail: '4 parallel streams: vendor+probe, T3 Code, other OSS' },
    { title: 'Verify', detail: "one skeptic per stream tries to refute its claims" },
  ],
}

const found = await agent('List every file', { schema: { type: 'object' } })
`;
    expect(parseWorkflowScriptMeta(script)).toEqual({
      name: "grok-build-provider-research",
      description: "Research how to add Grok Build as a first-class provider",
      phases: [
        { title: "Research", detail: "4 parallel streams: vendor+probe, T3 Code, other OSS" },
        { title: "Verify", detail: "one skeptic per stream tries to refute its claims" },
      ],
    });
  });

  it("decodes every quote style and escape", () => {
    const script = [
      "export let meta = {",
      String.raw`  name: "say \"hi\" A\u{1F600}",`,
      String.raw`  description: ` + "`line one\\nline \\`two\\` it\\'s \\\\ \\x41\\",
      "continued`,",
      "  phases: [{ title: `multi",
      "line` }],",
      "}",
    ].join("\n");
    expect(parseWorkflowScriptMeta(script)).toEqual({
      name: 'say "hi" A😀',
      description: "line one\nline `two` it's \\ Acontinued",
      phases: [{ title: "multi\nline" }],
    });
  });

  it("allows comments between tokens, quoted keys and trailing commas", () => {
    const script = `#!/usr/bin/env node
// A workflow.
/* header */ export var meta = /* the literal */ {
  "name": 'quoted', // trailing note
  'description' /* before the colon */ : "still read",
  phases: [
    // first phase
    { "title": "One", },
    ,
  ],
}`;
    expect(parseWorkflowScriptMeta(script)).toEqual({
      name: "quoted",
      description: "still read",
      phases: [{ title: "One" }],
    });
  });

  it("skips properties that are code and keeps the rest", () => {
    const script = `export const meta = {
  ...defaults,
  [computed]: 1,
  name: 'kept',
  schema: buildSchema({ pattern: /['"{]/g, nested: [1, { a: "}" }] }),
  run: async () => { const s = "}"; return s / 2 },
  helper() { return '{' },
  description: 'first ' + suffix,
  phases: [
    ...shared,
    { title: 'Plan', retries: 3, when: (x) => x > 1 },
    { title: 'Run' }.title,
    { title: 'Ship', detail: notALiteral },
  ],
  extra: \`\${a}\`,
}`;
    expect(parseWorkflowScriptMeta(script)).toEqual({
      name: "kept",
      phases: [{ title: "Plan" }, { title: "Ship" }],
    });
  });

  it("treats template interpolation as unreadable without losing the other keys", () => {
    const script =
      "export const meta = {\n" +
      "  name: 'research',\n" +
      "  description: `Look at ${target} and ${`nested ${deep}`}`,\n" +
      "  phases: [{ title: 'Read', detail: `${count} files` }],\n" +
      "}";
    expect(parseWorkflowScriptMeta(script)).toEqual({
      name: "research",
      phases: [{ title: "Read" }],
    });
  });

  it("returns null when there is no meta object literal", () => {
    expect(parseWorkflowScriptMeta("")).toBeNull();
    expect(parseWorkflowScriptMeta("const found = await agent('List every file')")).toBeNull();
    expect(parseWorkflowScriptMeta("export const meta = buildMeta()")).toBeNull();
    expect(parseWorkflowScriptMeta("export const metadata = { name: 'no' }")).toBeNull();
  });

  it("ignores a meta that sits in a comment, a string or a function body", () => {
    const script = `// export const meta = { name: 'in a line comment' }
/* export const meta = { name: 'in a block comment' } */
const note = "export const meta = { name: 'in a string' }";
const tpl = \`export const meta = { name: 'in a template' }\`;
function helper() { const meta = { name: 'in a function' }; return meta }
export const meta = { name: 'the real one' }`;
    expect(parseWorkflowScriptMeta(script)).toEqual({ name: "the real one", phases: [] });
  });

  it("trims strings, drops empty ones and caps phases and string length", () => {
    const phases = Array.from({ length: 60 }, (_, index) => `{ title: 'Phase ${index}' }`);
    const script = `export const meta = {
  name: '   ',
  description: '  ${"x".repeat(3_000)}  ',
  phases: [{ detail: 'no title' }, { title: 42 }, { title: '  Trimmed  ', detail: '' }, ${phases.join(", ")}],
}`;
    const meta = parseWorkflowScriptMeta(script);
    expect(meta?.name).toBeUndefined();
    expect(meta?.description).toBe("x".repeat(2_000));
    expect(meta?.phases).toHaveLength(50);
    expect(meta?.phases[0]).toEqual({ title: "Trimmed" });
    expect(meta?.phases[49]).toEqual({ title: "Phase 48" });
  });

  it("reads what is complete in a header that is still being written", () => {
    const script = `export const meta = {
  name: 'streaming',
  phases: [
    { title: 'Done', detail: 'all here' },
    { title: 'Half', detail: 'still typ`;
    expect(parseWorkflowScriptMeta(script)).toEqual({
      name: "streaming",
      phases: [{ title: "Done", detail: "all here" }, { title: "Half" }],
    });
  });

  it("stays linear on huge or hostile input", () => {
    const garbage = "[[[[{{{{((((".repeat(100_000);
    expect(parseWorkflowScriptMeta(`export const meta = { name: 'big' }\n${garbage}`)).toEqual({
      name: "big",
      phases: [],
    });
    expect(parseWorkflowScriptMeta(`export const meta = { name: 'big', junk: ${garbage}`)).toEqual({
      name: "big",
      phases: [],
    });
    expect(
      parseWorkflowScriptMeta(`export const meta = { name: 'deep', x: ${"`${".repeat(200_000)}`),
    ).toEqual({ name: "deep", phases: [] });
    expect(
      parseWorkflowScriptMeta(`export const meta = { name: '${"\\u{".repeat(300_000)}' }`),
    ).toEqual({ phases: [] });
    expect(parseWorkflowScriptMeta(`${garbage}\nexport const meta = { name: 'late' }`)).toBeNull();
  });
});

describe("humanizeWorkflowName", () => {
  it("turns kebab, snake and camel case names into a sentence-case label", () => {
    expect(humanizeWorkflowName("grok-build-provider-research")).toBe(
      "Grok build provider research",
    );
    expect(humanizeWorkflowName("  grok_build__provider  ")).toBe("Grok build provider");
    expect(humanizeWorkflowName("grokBuildProvider")).toBe("Grok build provider");
    expect(humanizeWorkflowName("parseHTTPResponse")).toBe("Parse HTTP response");
    expect(humanizeWorkflowName("sync-GitHub-PR-comments")).toBe("Sync GitHub PR comments");
    expect(humanizeWorkflowName("research")).toBe("research");
    expect(humanizeWorkflowName("  Research ")).toBe("Research");
    expect(humanizeWorkflowName("")).toBe("");
  });
});
