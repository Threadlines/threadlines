# Community agents: what the listed agents report (recorded 2026-10-05)

Recorded on macOS (Apple Silicon) with Will's approval: each of the 29 listed
agents (registry snapshot of that day, minus the five native ones and the
seven quarantined ones) was installed into a throwaway folder with a private
`HOME` and a stripped environment, started, sent `initialize` twice (once
with `auth.terminal` and the legacy `_meta["terminal-auth"]` capability, once
with `auth.terminal` only) and then `session/new`. No sign-ins. All 29
installed and answered.

| Agent              | Install                                     | Sign-in methods (both capabilities)       | (stable capability only)        | `session/new` signed out                                                                                                                                                       |
| ------------------ | ------------------------------------------- | ----------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| amp-acp            | tar.gz, 24 MB, 1 files, checksum            | legacy terminal                           | legacy terminal                 | opens; options: permission (mode), amp-mode (model)                                                                                                                            |
| auggie             | npm, 1.6s                                   | legacy terminal                           | none                            | -32000 Authentication required                                                                                                                                                 |
| autohand           | npm, 1.7s                                   | legacy terminal                           | legacy terminal                 | -32000 Authentication required                                                                                                                                                 |
| cline              | npm, 10.0s, install script                  | agent, agent, agent                       | agent, agent, agent             | -32000 Authentication required: Call authenticate before starting a                                                                                                            |
| codebuddy-code     | npm, 8.4s                                   | agent, agent, agent, agent                | agent, agent, agent, agent      | -32000 Authentication required                                                                                                                                                 |
| cortex-code        | tar.gz, 136 MB, 10593 files, no checksum    | none                                      | none                            | opens; options: mode (mode)                                                                                                                                                    |
| corust-agent       | tar.gz, 10 MB, 1 files, no checksum         | agent                                     | agent                           | -32000 Authentication required                                                                                                                                                 |
| devin              | tar.gz, 57 MB, 232 files, no checksum       | agent, terminal+legacy                    | agent, terminal                 | opens; options: mode (mode), model (model); `modes`                                                                                                                            |
| dimcode            | npm, 7.1s                                   | terminal                                  | terminal                        | -32000 Authentication required: Provider credentials are required                                                                                                              |
| dirac              | npm, 5.8s                                   | legacy terminal, agent, env_var, terminal | agent, agent, env_var, terminal | opens; options: mode (mode), auto_approve (mode), yolo (mode), provider (_provider), model (model), reasoning_effort (thought_level), thinking_budget (thought_level); `modes` |
| factory-droid      | npm, 6.9s, native bin, install script       | agent, agent                              | agent, agent                    | -32000 Authentication required: Your code: XXXX-XXXX Click the "Log                                                                                                            |
| gemini             | npm, 2.4s                                   | agent, agent, agent, agent                | agent, agent, agent, agent      | -32000 Gemini API key is missing or not configured.                                                                                                                            |
| github-copilot-cli | npm, 2.9s                                   | legacy terminal                           | legacy terminal                 | -32000 Authentication required                                                                                                                                                 |
| glm-acp-agent      | npm, 0.8s                                   | agent, env_var                            | agent, env_var                  | opens; options: thought_level (thought_level), mode (mode), model (model); legacy `models`; `modes`                                                                            |
| goose              | tar.bz2, 77 MB, 1 files, checksum           | agent                                     | agent                           | -32603 Internal error                                                                                                                                                          |
| grok-build         | npm, 3.5s, native bin, install script       | agent                                     | agent                           | -32000 Authentication required                                                                                                                                                 |
| harn               | tar.gz, 83 MB, 1 files, 2 links, checksum   | agent                                     | agent                           | -32602 [environment_policy.missing] session/new requires `environme                                                                                                            |
| junie              | zip, 334 MB, 364 files, no checksum         | agent, terminal+legacy                    | agent, terminal+legacy          | -32000 Authentication is required before this operation can be perf                                                                                                            |
| kilo               | zip, 52 MB, 408 files, checksum             | legacy terminal                           | agent                           | opens; options: model (model), effort (thought_level), mode (mode)                                                                                                             |
| kimchi             | tar.gz, 36 MB, 41 files, checksum           | agent, agent, terminal                    | agent, agent, terminal          | -32000 Authentication required: no credentials configured for the s                                                                                                            |
| kimi               | tar.gz, 68 MB, 1 files, checksum            | legacy terminal                           | legacy terminal                 | -32000 Authentication required                                                                                                                                                 |
| minimax-code       | npm, 4.0s, install script                   | terminal                                  | terminal                        | -32000 Authentication required: Run `mcode login` and try again.                                                                                                               |
| mistral-vibe       | tar.gz, 59 MB, 300 files, 2 links, checksum | agent, terminal+legacy                    | agent                           | -32000 Missing API key for mistral provider.                                                                                                                                   |
| nova               | npm, 13.4s, install script                  | terminal                                  | terminal                        | -32000 Click Nova Setup to configure your API keys                                                                                                                             |
| pi-acp             | npm, 0.7s                                   | terminal+legacy                           | terminal                        | -32603 Internal error: Could not start pi: executable not found (co                                                                                                            |
| poolside           | tar.gz, 14 MB, 1 files, checksum            | legacy terminal                           | none                            | -32000 Authentication required                                                                                                                                                 |
| qwen-code          | npm, 2.9s                                   | agent                                     | agent                           | -32000 Authentication required: Use Qwen Code CLI to authenticate f                                                                                                            |
| sigit              | tar.gz, 36 MB, 1 files, checksum            | agent                                     | agent                           | opens; options: sigit-model (model), sigit-local-inference (-), sigit-permission-mode (mode)                                                                                   |
| stakpak            | tar.gz, 27 MB, 1 files, no checksum         | agent                                     | agent                           | -32000 Authentication required                                                                                                                                                 |

## What this settled

- **Both sign-in capabilities are needed.** Seven agents only describe a
  terminal sign-in through the legacy `_meta["terminal-auth"]` form (amp-acp,
  auggie, autohand, github-copilot-cli, kilo, kimi, poolside); auggie and
  poolside list no method at all without it, and mistral-vibe hides its
  terminal method.
- **Legacy commands.** Most name a program inside their own install (their
  executable, or `node` with a script inside it; GitHub Copilot names a native
  binary from one of its own packages). Three name something else and are
  refused: autohand (`npm install -g autohand-cli`), junie's legacy entry
  (`npx @jetbrains/junie@latest`; its stable `terminal` method is used
  instead), kilo (`opencode auth login`).
- **Stable `terminal` arguments mean "replace", not "append", for six of the
  seven agents that use them** (dimcode `acp --auth-setup`, kimchi `login`,
  minimax-code `login`, nova `setup`, dirac `--acp-auth`, junie
  `--acp=false`), which is the registry guide's wording and not the
  protocol's. devin means append (`acp --login`) and says so in its legacy
  entry. Rule: a legacy entry that passes the policy wins; otherwise the
  method's arguments replace the registry entry's.
- **Signed-out `session/new`** is -32000 for 19 agents (with many different
  messages), an internal error for goose and pi-acp, invalid params for harn,
  and succeeds for seven. factory-droid starts a device-code login there and
  puts the code in the error text.
- **Model and mode** for the seven that open a session are all
  `configOptions`. Several options can carry category `mode` (dirac: `mode`,
  `auto_approve`, `yolo`), and the ids vary (`permission`,
  `sigit-permission-mode`, `amp-mode` for the model). cortex-code has no
  model choice at all. glm also sends the legacy `models` field. The other 22
  can't be seen without signing in.
- **npm packages:** two have a native program as their `bin` (factory-droid,
  grok-build); five run install scripts (cline, factory-droid, grok-build,
  minimax-code, nova); `engines` ranges from `>=18.17` to
  `>=22.19 <23 || >=24 <27` (minimax-code), all satisfied by Node 22.20.
- **Archives:** from one file to 10,593 files (cortex-code); symbolic links
  appear (harn, mistral-vibe); five of the fourteen carry no checksum.
- **Extras agents send:** vendor notifications (`_x.ai/session/setup`,
  `_cognition.ai/mcp/serversChanged`), `available_commands_update`,
  `config_option_update`, `current_mode_update`. Two agents report no
  `agentInfo`.
- Start-up took under seven seconds for every agent.
