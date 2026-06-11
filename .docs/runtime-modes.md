# Runtime modes

Threadlines has two per-thread mode axes in the composer footer:

- **Interaction mode** (`ProviderInteractionMode`): `default` ("Build") or `plan`. What kind of turn this is.
- **Runtime mode** (`RuntimeMode`): how much the agent may do without asking. Four tiers, most supervised to most permissive:

| Mode                | Label                 | Claude (`permissionMode`)                                            | Codex (`approvalPolicy` + `sandbox`)                                  |
| ------------------- | --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `approval-required` | Supervised            | default (everything prompts through `canUseTool`)                    | `untrusted` + `read-only`                                             |
| `auto-accept-edits` | Auto-accept edits     | `acceptEdits`                                                        | `on-request` + `workspace-write`                                      |
| `auto`              | Auto                  | `auto` (classifier reviews actions; fallback prompts surface in-app) | `on-request` + `workspace-write` + `approvalsReviewer: "auto_review"` |
| `full-access`       | Full access (default) | `bypassPermissions` + allow-dangerously flag                         | `never` + `danger-full-access`                                        |

Changing the runtime mode mid-thread restarts the provider session with the new
settings (`ProviderCommandReactor` treats it as a restart trigger).

## Auto mode notes

- **Claude**: requires a classifier-capable model (Opus 4.6+, Sonnet 4.6+,
  Fable). `claude-opus-4-5` and `claude-haiku-4-5` advertise
  `supportedRuntimeModes` without `auto`; the UI disables the option for them
  and the adapter clamps `auto` to `acceptEdits` if it arrives anyway. Auto
  mode is account-dependent (admin-disableable, research preview); if the SDK
  rejects it the session errors like any other config failure. Classifier
  denials are deny-and-continue (the agent reroutes); after 3 consecutive or
  20 total blocks Claude Code falls back to prompting, which lands in the
  normal in-app approval panel via `canUseTool`.
- **Codex**: `auto_review` routes sandbox-escalation approvals to a reviewer
  subagent instead of the user (requires `on-request`; with `never` nothing is
  ever reviewed). Reviewer activity arrives as
  `item/autoApprovalReview/started|completed` notifications, which the
  CodexAdapter already maps into `approval-review` task events on the
  timeline.
- **Cursor / OpenCode**: no native auto tier. Their snapshots omit
  `supportedRuntimeModes`, so the web falls back to `LEGACY_RUNTIME_MODES`
  and never offers Auto. If `auto` reaches those adapters anyway, Cursor
  resolves it like the permissive modes and OpenCode treats any
  non-full-access mode as ask-everything.

## Provider gating

`ServerProvider.supportedRuntimeModes` (provider level) and
`ServerProviderModel.supportedRuntimeModes` (per-model restriction) drive the
picker: provider-unsupported modes are hidden, model-unsupported modes are
shown disabled with a reason. Helpers live in
`apps/web/src/providerModels.ts`; presentation/copy in
`apps/web/src/runtimeModeOptions.ts`.

## Plan-mode interplay

Plan turns do not inherit permissive runtime modes. The Claude adapter tracks
the current interaction mode and `canUseTool` refuses the full-access
auto-allow during plan turns, so a plan turn cannot silently edit files
(matches Claude Code, where plan mode prompts like default mode). Codex plan
mode is prompt-level only, same as the Codex TUI. The composer de-emphasizes
the runtime select while Plan is active.

The default for new threads is still `full-access` (`DEFAULT_RUNTIME_MODE`).
Flipping the default to `auto` is a deliberate product decision left open;
see `runtime-modes-provider-research` memory and the June 2026 provider docs.
