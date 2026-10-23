/**
 * Says what still runs in this computer's terminals, for the quit and
 * restart-to-install prompts. Commands are named when there are one or two
 * and both are known; otherwise the sentence counts. `onThisComputer` names
 * the place when other computers have work too.
 */
export function BusyTerminalsSentence({
  commands,
  onThisComputer = false,
}: {
  commands: ReadonlyArray<string | null>;
  onThisComputer?: boolean;
}) {
  const where = onThisComputer ? " on this computer" : "";
  const [first, second] = commands;
  if (commands.length === 1) {
    return first ? (
      <>
        <code className="text-foreground/90">{first}</code> is still running in a terminal{where}.
      </>
    ) : (
      <>A terminal is still running a command{where}.</>
    );
  }
  if (commands.length === 2 && first && second) {
    return (
      <>
        <code className="text-foreground/90">{first}</code> and{" "}
        <code className="text-foreground/90">{second}</code> are still running in terminals
        {where}.
      </>
    );
  }
  return (
    <>
      {commands.length} terminals are still running commands{where}.
    </>
  );
}
