/**
 * The project's text an agent's session starts with, as the agent reads it
 * (docs/design/project-brief-notes.md, "What an agent is told"). The brief is
 * the user's words, framed as their standing instructions.
 */
export function projectInstructionsText(input: {
  readonly projectTitle: string;
  readonly brief: string;
}): string | undefined {
  const brief = input.brief.trim();
  if (brief.length === 0) return undefined;
  return [
    `Project brief for "${input.projectTitle}", from the user. It applies to every thread in this project:`,
    brief,
  ].join("\n");
}
