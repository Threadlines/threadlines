import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { deriveProviderInstanceEntries } from "~/providerInstances";

import { ProviderReviewDialog } from "./ProviderReviewDialog";

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const MODEL = "gpt-5.6-sol";

const CODEX_PROVIDER: ServerProvider = {
  driver: CODEX_DRIVER,
  instanceId: CODEX_INSTANCE_ID,
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "0.116.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-10T00:00:00.000Z",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: MODEL,
      name: "GPT-5.6",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      }),
    },
  ],
};

describe("ProviderReviewDialog", () => {
  it("always confirms the new thread and exposes Codex model and reasoning controls", async () => {
    const onConfirm = vi.fn();
    const onModelSelectionChange = vi.fn();
    const providerInstanceEntries = deriveProviderInstanceEntries([CODEX_PROVIDER]);

    const screen = await render(
      <ProviderReviewDialog
        open
        targetDescription="Polish source control review flow"
        modelSelection={{
          instanceId: CODEX_INSTANCE_ID,
          model: MODEL,
          options: [{ id: "reasoningEffort", value: "medium" }],
        }}
        providerInstanceEntries={providerInstanceEntries}
        modelOptionsByInstance={new Map([[CODEX_INSTANCE_ID, CODEX_PROVIDER.models]])}
        isPending={false}
        onOpenChange={vi.fn()}
        onModelSelectionChange={onModelSelectionChange}
        onConfirm={onConfirm}
      />,
    );

    await expect
      .element(page.getByRole("heading", { name: "Start review in a new thread" }))
      .toBeVisible();
    await expect.element(page.getByText("Codex model", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Reasoning and options", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /GPT-5\.6/u })).toBeVisible();
    const reasoningTrigger = page.getByRole("button", { name: /Medium/u });
    await expect.element(reasoningTrigger).toBeVisible();

    await userEvent.click(reasoningTrigger);
    await userEvent.click(page.getByRole("menuitemradio", { name: "High" }));
    expect(onModelSelectionChange).toHaveBeenCalledWith({
      instanceId: CODEX_INSTANCE_ID,
      model: MODEL,
      options: [{ id: "reasoningEffort", value: "high" }],
    });

    await userEvent.click(page.getByRole("button", { name: "Start review" }));
    expect(onConfirm).toHaveBeenCalledOnce();

    await screen.unmount();
  });
});
