/**
 * Shell side of running a suggested command from the chat
 * (docs/terminal-command-runs.md).
 *
 * A `run` spawns the user's shell with a small wrapper instead of typing into
 * a prompt: the wrapper evaluates the command in a subshell, prints an OSC
 * marker carrying the run id and exit status, then execs a normal interactive
 * shell so the tab carries on. The command and run id travel in environment
 * variables the wrapper removes before anything else runs.
 */
import xtermHeadless from "@xterm/headless";

const { Terminal: HeadlessTerminal } = xtermHeadless;

/** OSC number of the end-of-run marker: `ESC ] 6973 ; <run id> ; <status> BEL`. */
export const COMMAND_RUN_MARKER_OSC = "6973";
export const COMMAND_RUN_ENV = {
  command: "THREADLINES_RUN_COMMAND",
  runId: "THREADLINES_RUN_ID",
  shell: "THREADLINES_RUN_SHELL",
} as const;

/** Raw output kept per run before rendering; the end is what matters. */
export const COMMAND_RUN_CAPTURE_LIMIT = 512 * 1024;
/** Rendered output kept for the agent, from the end. */
export const COMMAND_RUN_OUTPUT_LIMIT = 16_000;

/** The run id and exit status in a marker's OSC content, or null for any other OSC. */
export function parseCommandRunMarker(
  content: string,
): { readonly runId: string; readonly exitCode: number | null } | null {
  const match = /^6973;([^;]+);(-?\d+)?$/.exec(content);
  if (!match) return null;
  const exitCode = match[2] === undefined ? null : Number.parseInt(match[2], 10);
  return { runId: match[1]!, exitCode: Number.isFinite(exitCode) ? exitCode : null };
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * POSIX wrapper. The wrapper shell ignores Ctrl+C and Ctrl+\ (`trap :`), so
 * an interrupt ends only the subshell running the command (status 130) and
 * the marker still prints. The subshell ignores Ctrl+Z: without job control
 * a stopped command could never be resumed.
 */
export function posixCommandRunWrapper(afterShellArgs: ReadonlyArray<string>): string {
  const execArgs = afterShellArgs.map(posixQuote).join(" ");
  return [
    `__tl_cmd=$${COMMAND_RUN_ENV.command}; __tl_id=$${COMMAND_RUN_ENV.runId}; __tl_sh=$${COMMAND_RUN_ENV.shell}`,
    `unset ${COMMAND_RUN_ENV.command} ${COMMAND_RUN_ENV.runId} ${COMMAND_RUN_ENV.shell}`,
    "trap : INT QUIT",
    `( trap - INT QUIT; trap '' TSTP; eval "$__tl_cmd" )`,
    "__tl_status=$?",
    `printf '\\033]${COMMAND_RUN_MARKER_OSC};%s;%s\\007' "$__tl_id" "$__tl_status"`,
    "unset __tl_cmd __tl_id __tl_status",
    `exec "$__tl_sh"${execArgs.length > 0 ? ` ${execArgs}` : ""}`,
  ].join("\n");
}

/**
 * PowerShell wrapper, appended to the prompt hook of a `-NoExit -Command`
 * shell, which stays interactive afterwards. Ctrl+C stops the whole script,
 * so no marker prints; the next prompt marker then ends the run instead.
 */
export const POWERSHELL_COMMAND_RUN_WRAPPER = [
  `$__tl_cmd = $env:${COMMAND_RUN_ENV.command}`,
  `$__tl_id = $env:${COMMAND_RUN_ENV.runId}`,
  `Remove-Item Env:${COMMAND_RUN_ENV.command}, Env:${COMMAND_RUN_ENV.runId}, Env:${COMMAND_RUN_ENV.shell} -ErrorAction SilentlyContinue`,
  "$global:LASTEXITCODE = 0",
  "$__tl_ok = $true",
  "try { Invoke-Expression $__tl_cmd; $__tl_ok = $? } catch { Write-Error $_; $__tl_ok = $false }",
  "$__tl_status = if ($global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } elseif ($__tl_ok) { 0 } else { 1 }",
  `[Console]::Write(([char]27).ToString() + ']${COMMAND_RUN_MARKER_OSC};' + $__tl_id + ';' + $__tl_status + ([char]7).ToString())`,
  "Remove-Variable __tl_cmd, __tl_id, __tl_ok, __tl_status -ErrorAction SilentlyContinue",
].join("; ");

/**
 * What a terminal printed, as a person reads it afterwards: redraws collapse
 * to their last frame, colors drop, a full-screen program leaves only what it
 * left on the normal screen, and wrapped lines join.
 */
export function renderTerminalText(raw: string, cols: number): Promise<string> {
  const lineCount = raw.split("\n").length;
  const terminal = new HeadlessTerminal({
    cols: Math.max(20, Math.min(cols, 500)),
    rows: 24,
    scrollback: Math.min(Math.max(lineCount * 2, 100), 50_000),
    allowProposedApi: true,
  });
  return new Promise<string>((resolve) => {
    terminal.write(raw, () => {
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        if (!line) continue;
        const text = line.translateToString(true);
        if (line.isWrapped && lines.length > 0) {
          lines[lines.length - 1] += text;
        } else {
          lines.push(text);
        }
      }
      terminal.dispose();
      while (lines.length > 0 && lines.at(-1)!.trim().length === 0) lines.pop();
      while (lines.length > 0 && lines[0]!.trim().length === 0) lines.shift();
      resolve(lines.map((line) => line.trimEnd()).join("\n"));
    });
  });
}

/** Keeps the end of long output, where results and errors are, and says what was cut. */
export function clipCommandOutput(text: string, clippedBefore: boolean): string {
  if (text.length <= COMMAND_RUN_OUTPUT_LIMIT && !clippedBefore) return text;
  const tail =
    text.length > COMMAND_RUN_OUTPUT_LIMIT ? text.slice(-COMMAND_RUN_OUTPUT_LIMIT) : text;
  const firstBreak = tail.indexOf("\n");
  const whole =
    text.length > COMMAND_RUN_OUTPUT_LIMIT && firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail;
  return `(earlier output cut)\n${whole}`;
}
