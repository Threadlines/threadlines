import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectWriteFileResult,
} from "./project.ts";

const decodeReadResult = Schema.decodeUnknownEffect(ProjectReadFileResult);
const decodeWriteResult = Schema.decodeUnknownEffect(ProjectWriteFileResult);
const decodeSearchEntriesInput = Schema.decodeUnknownEffect(ProjectSearchEntriesInput);

it.effect("accepts an empty workspace-entry query for initial browsing", () =>
  Effect.gen(function* () {
    const input = yield* decodeSearchEntriesInput({
      cwd: "/tmp/project",
      query: "",
      limit: 80,
    });
    assert.equal(input.query, "");
  }),
);

// Hosted-app version skew: a newer web bundle must tolerate responses from a
// server that predates content hashing and the written/conflict union.

it.effect("decodes text reads without a contentHash as an empty hash", () =>
  Effect.gen(function* () {
    const result = yield* decodeReadResult({
      kind: "text",
      relativePath: "src/main.ts",
      content: "export {};\n",
      size: 11,
      truncated: false,
    });
    assert.deepEqual(result, {
      kind: "text",
      relativePath: "src/main.ts",
      content: "export {};\n",
      size: 11,
      truncated: false,
      contentHash: "",
    });
  }),
);

it.effect("decodes legacy bare write results as unguarded written", () =>
  Effect.gen(function* () {
    const result = yield* decodeWriteResult({ relativePath: "plan.md" });
    assert.deepEqual(result, {
      kind: "written",
      relativePath: "plan.md",
      contentHash: "",
    });
  }),
);

it.effect("still decodes conflicts distinctly from written results", () =>
  Effect.gen(function* () {
    const result = yield* decodeWriteResult({
      kind: "conflict",
      relativePath: "plan.md",
      content: "disk contents",
      contentHash: "abc123",
      size: 13,
    });
    assert.equal(result.kind, "conflict");
  }),
);
