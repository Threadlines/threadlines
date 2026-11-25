import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../../lib/chatMarkdownDocument";
import { GITHUB_HTML_REHYPE_PLUGINS } from "../../lib/githubMarkdownHtml";

interface GitHubHtmlMarkdownProps {
  readonly text: string;
  readonly components: Components;
  readonly urlTransform: UrlTransform;
}

/**
 * Renders GitHub-authored markdown that can contain sanitized HTML (PR bodies
 * and comments). Kept in its own chunk so `parse5` and `rehype-raw` stay out
 * of normal chat markdown.
 */
export default function GitHubHtmlMarkdown({
  text,
  components,
  urlTransform,
}: GitHubHtmlMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={GITHUB_HTML_REHYPE_PLUGINS}
      components={components}
      urlTransform={urlTransform}
    >
      {text}
    </ReactMarkdown>
  );
}
