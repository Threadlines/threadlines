import type { ServerProviderSkill } from "@threadlines/contracts";

import { findBareImagePaths, findBareLocalhostUrls } from "../markdown-links";

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

/**
 * A stretch of prose the chat draws as something other than its text: a skill
 * chip, a dev-server link, or an image preview for a bare path.
 */
export type InlineTokenSpan =
  | {
      readonly kind: "skill";
      readonly start: number;
      readonly end: number;
      readonly skill: InlineSkill;
      readonly rawText: string;
    }
  | {
      readonly kind: "localhost";
      readonly start: number;
      readonly end: number;
      readonly url: string;
      readonly text: string;
    }
  | {
      readonly kind: "bare-image";
      readonly start: number;
      readonly end: number;
      readonly path: string;
    };

/**
 * Every replacement to make in one string, in order and without overlaps.
 *
 * Both passes run over the same text, so they are collected together rather
 * than chained: a second pass over the first one's output would have to walk
 * back into elements it did not make. SkillInlineText draws these; find in
 * chat reads them to know what the reader sees.
 */
export function findInlineTokenSpans(
  text: string,
  options: {
    readonly skills: ReadonlyArray<InlineSkill>;
    /** Bare image paths become previews only in settled prose. */
    readonly bareImagePaths: boolean;
  },
): InlineTokenSpan[] {
  const tokens: InlineTokenSpan[] = [];

  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const rawText = `$${name}`;
    const skill = options.skills.find((candidate) => candidate.name === name);
    if (!skill) {
      continue;
    }
    tokens.push({ kind: "skill", start, end: start + rawText.length, skill, rawText });
  }

  for (const match of findBareLocalhostUrls(text)) {
    tokens.push({
      kind: "localhost",
      start: match.start,
      end: match.end,
      url: match.url,
      text: match.text,
    });
  }

  if (options.bareImagePaths) {
    for (const match of findBareImagePaths(text)) {
      tokens.push({ kind: "bare-image", start: match.start, end: match.end, path: match.text });
    }
  }

  tokens.sort((left, right) => left.start - right.start);

  const ordered: InlineTokenSpan[] = [];
  let consumed = 0;
  for (const token of tokens) {
    if (token.start < consumed) {
      continue;
    }
    ordered.push(token);
    consumed = token.end;
  }
  return ordered;
}
