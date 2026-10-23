import { describe, expect, it } from "vite-plus/test";

import { normalizeChatMath } from "./chatMarkdownMath";

describe("normalizeChatMath", () => {
  it("reads the ways models write math as $$ math", () => {
    expect(normalizeChatMath("Sorting is $O(n \\log n)$ here.")).toBe(
      "Sorting is $$O(n \\log n)$$ here.",
    );
    expect(normalizeChatMath("Let $x$ be the count, so \\(x^2\\) grows.")).toBe(
      "Let $$x$$ be the count, so $$x^2$$ grows.",
    );
    expect(normalizeChatMath("where \\[a+b\\] holds")).toBe("where $$a+b$$ holds");
    expect(normalizeChatMath("The area:\n\\[\n\\pi r^2\n\\]\ndone")).toBe(
      "The area:\n$$\n\\pi r^2\n$$\ndone",
    );
    expect(normalizeChatMath("$$E = mc^2$$")).toBe("$$\nE = mc^2\n$$");
    expect(normalizeChatMath("  \\[x = 1\\]")).toBe("  $$\n  x = 1\n  $$");
    expect(normalizeChatMath("$$x = 1\ny = 2$$")).toBe("$$\nx = 1\ny = 2\n$$");
  });

  it("leaves dollars that are not math alone", () => {
    const prose = [
      "It costs $5 and $10, or $1,000-$2,000.",
      "Set $HOME/$USER, or ${HOME}/$USER, or ${a}-${b}.",
      "Match foo$|bar$ and call $(document).ready().",
      "Run $foo,$bar and echo $PATH.",
      "A literal \\$5 stays, and so does $HOME$.",
    ];
    for (const line of prose) {
      expect(normalizeChatMath(line)).toBe(line);
    }
  });

  it("never rewrites code, links, definitions or URLs, wherever they sit", () => {
    const untouched = [
      "Use `$x$` or ``echo $a$`` here.",
      "```\necho $x$\n\\[a\\]\n```",
      "- ```sh\n  echo $x$\n  ```",
      "> ```\n> echo $x$\n> ```",
      "`code\n$x$\nend`",
      "# Heading\n    echo $x$",
      "Text\n\n    echo ${HOME}/$x$",
      "See [the log](https://host/$x$/log) and https://host/$y$/z.",
      "[file](\n/$x$/log\n)",
      "[ref]: /$x$/log",
      "Open www.example.com/$x$/log now.",
      "An <code>$x$</code> stays.",
      'Use <code title="a > b">$x$</code> and <kbd>$y$</kbd >.',
      "Use $HOME/${USER}/repo.",
    ];
    for (const text of untouched) {
      expect(normalizeChatMath(text)).toBe(text);
    }
    // Indented under a list item it is the item's text, not code.
    expect(normalizeChatMath("- step\n\n    then $x$")).toBe("- step\n\n    then $$x$$");
  });

  it("keeps math in a table row inline, so the row stays in its table", () => {
    expect(normalizeChatMath("| Formula |\n| --- |\n| $$x+y$$ |")).toBe(
      "| Formula |\n| --- |\n| $$x+y$$ |",
    );
    expect(normalizeChatMath("| a |\n| --- |\n| $x$ |")).toBe("| a |\n| --- |\n| $$x$$ |");
  });

  it("keeps every line of a display block, and writes out one that never closes", () => {
    expect(normalizeChatMath("$$x=1\n\nx+1=2$$")).toBe("$$\nx=1\n\nx+1=2\n$$");
    expect(normalizeChatMath("$$\nx")).toBe("\\$\\$\nx");
    expect(normalizeChatMath("$$x=1\nx=2")).toBe("\\$\\$x=1\nx=2");
    // An inline formula later on doesn't close a display block.
    expect(normalizeChatMath("$$\nx\n\nA formula $$y$$")).toBe("\\$\\$\nx\n\nA formula $$y$$");
  });

  it("reads display math in list items and quotes, and with Windows line endings", () => {
    expect(normalizeChatMath("- $$\n  x=1\n  $$")).toBe("- $$\n  x=1\n  $$");
    expect(normalizeChatMath("- $$x=1\n  y=2$$")).toBe("- $$\n  x=1\n  y=2\n  $$");
    expect(normalizeChatMath("> \\[\n> a\n> \\]")).toBe("> $$\n> a\n> $$");
    expect(normalizeChatMath("1. $$E = mc^2$$")).toBe("1. $$\n   E = mc^2\n   $$");
    expect(normalizeChatMath("\\[\r\nx^2\r\n\r\ny^2\r\n\\]")).toBe("$$\nx^2\n\ny^2\n$$");
  });

  it("reads a line of many nested quote markers at once", () => {
    // The line-start patterns once tried every way to share the spaces
    // between markers: 2^40 tries before saying this isn't display math.
    const line = `${"> ".repeat(40)}x costs $5`;
    expect(normalizeChatMath(line)).toBe(line);
  });

  it("waits for the character after a closing dollar while a reply streams", () => {
    // `$5-$` might still become `$5-$10`.
    expect(normalizeChatMath("from $5-$", { streaming: true })).toBe("from $5-$");
    expect(normalizeChatMath("let $x$", { streaming: true })).toBe("let $x$");
    expect(normalizeChatMath("let $x$.", { streaming: true })).toBe("let $$x$$.");
    // An unanswered `\[` is not a block yet, and a `$$` with words on its
    // line waits for its closer before it becomes one.
    expect(normalizeChatMath("\\[\n\\pi r", { streaming: true })).toBe("\\[\n\\pi r");
    expect(normalizeChatMath("$$x=1\nx=2", { streaming: true })).toBe("\\$\\$x=1\nx=2");
    // A bare `$$` being written is a display block still open.
    expect(normalizeChatMath("$$\nx^2", { streaming: true })).toBe("$$\nx^2");
  });
});
