/**
 * Tool-use evals: how real models use the tools Threadlines gives agents
 * (apps/server/evals/toolUse). Runs on the developer's subscription sign-ins
 * from eval-only settings folders, never per-use billing.
 *
 *   node scripts/eval-tool-use.ts --provider claude|codex [--model <id>] [--case <name>] [--samples 2]
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL_BY_PROVIDER, ProviderDriverKind } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import { TOOL_USE_CASES } from "../evals/toolUse/cases.ts";
import { checkCodexEvalSetup, EVAL_HOME, EvalSetupError } from "../evals/toolUse/isolation.ts";
import { runToolUseCase, type CaseResult, type EvalProvider } from "../evals/toolUse/runCase.ts";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "2" },
  },
});
const provider = values.provider as EvalProvider | undefined;
if (provider !== "claude" && provider !== "codex") {
  throw new Error("Pass --provider claude or --provider codex.");
}
const model =
  values.model ??
  DEFAULT_MODEL_BY_PROVIDER[
    ProviderDriverKind.make(provider === "claude" ? "claudeAgent" : "codex")
  ]!;
const samples = Number(values.samples);
const cases = TOOL_USE_CASES.filter(
  (entry) => values.case === undefined || entry.name === values.case,
);
if (cases.length === 0) throw new Error(`No case named ${values.case}.`);

if (provider === "codex") await checkCodexEvalSetup();

console.log(`${provider} ${model}: ${cases.length} cases × ${samples} samples`);
const results: Array<CaseResult> = [];
for (const testCase of cases) {
  for (let sample = 1; sample <= samples; sample += 1) {
    const result = await Effect.runPromise(
      runToolUseCase({ provider, model, testCase, timeoutMs: 5 * 60_000 }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        // A case that breaks is a failed case; a setup problem stops the run.
        Effect.catchDefect((defect) =>
          defect instanceof EvalSetupError
            ? Effect.die(defect)
            : Effect.succeed<CaseResult>({
                case: testCase.name,
                provider,
                model,
                passed: false,
                failures: [`crashed: ${defect instanceof Error ? defect.message : String(defect)}`],
                run: { calls: [], native: [], reply: "" },
              }),
        ),
      ),
    );
    results.push(result);
    console.log(
      `  ${result.passed ? "pass" : "FAIL"}  ${testCase.name} #${sample}${
        result.passed ? "" : `: ${result.failures.join("; ")}`
      }`,
    );
  }
}

const passed = results.filter((result) => result.passed).length;
console.log(`\n${passed}/${results.length} passed`);
for (const testCase of cases) {
  const runs = results.filter((result) => result.case === testCase.name);
  console.log(
    `  ${runs.filter((result) => result.passed).length}/${runs.length}  ${testCase.name}`,
  );
}
const output = nodePath.join(
  EVAL_HOME,
  "results",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${provider}-${model}.json`,
);
fs.mkdirSync(nodePath.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ provider, model, samples, results }, null, 2));
console.log(`\nfull results: ${output}`);
