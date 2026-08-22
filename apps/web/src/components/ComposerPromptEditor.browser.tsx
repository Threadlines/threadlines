import "../index.css";

import { useRef, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
  type ComposerSkillAvailability,
} from "./ComposerPromptEditor";

function EditorHarness(props: {
  recognizedSlashCommands: ReadonlyArray<string>;
  initialValue?: string;
  skillAvailability?: ComposerSkillAvailability;
}) {
  const [value, setValue] = useState(props.initialValue ?? "");
  const [cursor, setCursor] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);

  return (
    <>
      <ComposerPromptEditor
        value={value}
        cursor={cursor}
        terminalContexts={[]}
        skills={[]}
        recognizedSlashCommands={props.recognizedSlashCommands}
        disabled={false}
        placeholder="Type here"
        onRemoveTerminalContext={vi.fn()}
        onChange={(nextValue, nextCursor) => {
          setValue(nextValue);
          setCursor(nextCursor);
        }}
        onPaste={vi.fn()}
        editorRef={editorRef}
        {...(props.skillAvailability ? { skillAvailability: props.skillAvailability } : {})}
      />
      <span data-testid="composer-prompt-value">{value}</span>
    </>
  );
}

async function typeIntoEditor(text: string) {
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await userEvent.keyboard(text);
}

function commandTokenText(): string | null {
  return document.querySelector(".composer-command-token")?.textContent ?? null;
}

describe("ComposerPromptEditor command token", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("tints a recognized leading command and keeps arguments plain", async () => {
    const screen = await render(
      <EditorHarness recognizedSlashCommands={["goal", "plan", "default"]} />,
    );
    await typeIntoEditor("/goal ship the feature");

    await expect.poll(commandTokenText).toBe("/goal");
    expect(document.querySelectorAll(".composer-command-token")).toHaveLength(1);
    await screen.unmount();
  });

  it("demotes the token when the command stops matching", async () => {
    const screen = await render(
      <EditorHarness recognizedSlashCommands={["goal", "plan", "default"]} />,
    );
    await typeIntoEditor("/goal");
    await expect.poll(commandTokenText).toBe("/goal");

    await userEvent.keyboard("s");
    await expect.poll(commandTokenText).toBeNull();
    await screen.unmount();
  });

  it("ignores commands that are not at the start of the prompt", async () => {
    const screen = await render(
      <EditorHarness recognizedSlashCommands={["goal", "plan", "default"]} />,
    );
    await typeIntoEditor("see /goal for details");

    await expect
      .poll(() => page.getByTestId("composer-editor").query()?.textContent)
      .toContain("/goal");
    expect(commandTokenText()).toBeNull();
    await screen.unmount();
  });

  it("ignores commands the thread does not support", async () => {
    const screen = await render(<EditorHarness recognizedSlashCommands={["plan", "default"]} />);
    await typeIntoEditor("/goal ship it");

    await expect
      .poll(() => page.getByTestId("composer-editor").query()?.textContent)
      .toContain("/goal");
    expect(commandTokenText()).toBeNull();
    await screen.unmount();
  });

  it("tints a namespaced provider command and keeps the prompt plain text", async () => {
    const screen = await render(
      <EditorHarness recognizedSlashCommands={["plan", "default", "posthog:signals"]} />,
    );
    await typeIntoEditor("/posthog:signals check the inbox");

    await expect.poll(commandTokenText).toBe("/posthog:signals");
    await expect
      .poll(() => page.getByTestId("composer-prompt-value").query()?.textContent)
      .toBe("/posthog:signals check the inbox");
    await screen.unmount();
  });
});

describe("ComposerPromptEditor skill chip", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("marks a skill chip stale once the provider's skill list is authoritative", async () => {
    const availability = (authoritative: boolean): ComposerSkillAvailability => ({
      knownSkillNames: new Set<string>(),
      authoritative,
      staleReason: "Not available with the selected provider",
    });
    const screen = await render(
      <EditorHarness
        recognizedSlashCommands={[]}
        initialValue="$review-diff please"
        skillAvailability={availability(false)}
      />,
    );

    await expect
      .poll(() => document.querySelectorAll("[data-composer-skill-chip]"))
      .toHaveLength(1);
    expect(document.querySelector("[data-composer-skill-stale]")).toBeNull();

    await screen.rerender(
      <EditorHarness
        recognizedSlashCommands={[]}
        initialValue="$review-diff please"
        skillAvailability={availability(true)}
      />,
    );

    await expect
      .poll(() => document.querySelectorAll("[data-composer-skill-stale]"))
      .toHaveLength(1);
    await screen.unmount();
  });
});
