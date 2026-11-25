import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * GitHub's own allowlist, which is what the host already applied to the text
 * before it reached us. Anything outside it is unwrapped to its children, so a
 * `<relative-time>` still reads as its date and a `<picture>` as its image.
 */
export const GITHUB_HTML_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, defaultSchema],
];
