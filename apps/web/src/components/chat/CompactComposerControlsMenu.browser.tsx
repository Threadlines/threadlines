import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerProviderModel,
  ThreadId,
} from "@threadlines/contracts";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { createModelCapabilities, createModelSelection } from "@threadlines/shared/model";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";
import { runtimeModeConfig, type RuntimeModeOption } from "../../runtimeModeOptions";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

const TEST_RUNTIME_MODE_OPTIONS: ReadonlyArray<RuntimeModeOption> = (
  ["approval-required", "auto-accept-edits", "full-access"] as const
).map((mode) => ({
  mode,
  label: runtimeModeConfig[mode].label,
  description: runtimeModeConfig[mode].description,
  icon: runtimeModeConfig[mode].icon,
}));

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; description?: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

async function mountMenu(props?: { modelSelection?: ModelSelection; prompt?: string }) {
  const threadId = ThreadId.make("thread-compact-menu");
  const threadRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
  const threadKey = scopedThreadKey(threadRef);
  const provider = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make(props?.modelSelection?.instanceId ?? provider);
  const model =
    props?.modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;

  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [threadKey]: {
        prompt: props?.prompt ?? "",
        attachments: [],
        nonPersistedAttachmentIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        transcriptHighlightContexts: [],
        fileSelectionContexts: [],
        pickedElementContexts: [],
        drawingContexts: [],
        modelSelectionByProvider: {
          [instanceId]: createModelSelection(instanceId, model, props?.modelSelection?.options),
        },
        activeProvider: instanceId,
        runtimeMode: null,
        interactionMode: null,
      },
    },
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const providerOptions = props?.modelSelection?.options;
  const models = [
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("effort", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
          ]),
          booleanDescriptor("fastMode", "Fast Mode"),
        ],
      }),
    },
    {
      slug: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [booleanDescriptor("thinking", "Thinking")],
      }),
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("effort", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
          ]),
        ],
      }),
    },
  ];
  const screen = await render(
    <CompactComposerControlsMenu
      interactionMode="default"
      runtimeMode="approval-required"
      runtimeModeOptions={TEST_RUNTIME_MODE_OPTIONS}
      showInteractionModeToggle
      traitsMenuContent={
        <TraitsMenuContent
          provider={provider}
          models={models}
          threadRef={threadRef}
          model={model}
          modelOptions={providerOptions}
        />
      }
      onInteractionModeChange={vi.fn()}
      onRuntimeModeChange={vi.fn()}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

async function mountTraitsPicker(props: {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions?: ReadonlyArray<ProviderOptionSelection>;
  iconOnly?: boolean;
  working?: boolean;
  omitOptionIds?: ReadonlyArray<string>;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const changes: Array<ReadonlyArray<{ id: string; value: string | boolean }> | undefined> = [];
  const screen = await render(
    <TraitsPicker
      provider={props.provider}
      models={props.models}
      model={props.model}
      modelOptions={props.modelOptions}
      {...(props.iconOnly !== undefined ? { iconOnly: props.iconOnly } : {})}
      {...(props.working !== undefined ? { working: props.working } : {})}
      {...(props.omitOptionIds ? { omitOptionIds: props.omitOptionIds } : {})}
      onModelOptionsChange={(nextOptions) => {
        changes.push(nextOptions);
      }}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    changes,
    cleanup,
  };
}

function ultracodeModelProps(modelOptions: ReadonlyArray<ProviderOptionSelection>) {
  const model = "claude-opus-5-5";
  return {
    provider: ProviderDriverKind.make("claudeAgent"),
    model,
    modelOptions,
    models: [
      {
        slug: model,
        name: "Claude Opus 5.5",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
              { id: "max", label: "Max" },
            ]),
            booleanDescriptor("ultracode", "Ultracode"),
          ],
        }),
      },
    ],
  };
}

describe("CompactComposerControlsMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode as a single switch for Opus", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
      ),
    });

    await page.getByLabelText("More composer controls").click();

    const fastModeToggle = page.getByRole("menuitemcheckbox", { name: "Fast Mode" });
    await expect.element(fastModeToggle).toBeInTheDocument();
    await expect.element(fastModeToggle).toHaveAttribute("aria-checked", "false");
    await expect.element(page.getByRole("menuitemradio", { name: "On" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("menuitemradio", { name: "Off" })).not.toBeInTheDocument();
  });

  it("shows Codex binary service tiers as a fast mode switch", async () => {
    const provider = ProviderDriverKind.make("codex");
    const model = "gpt-5.5";
    await using mounted = await mountTraitsPicker({
      provider,
      model,
      models: [
        {
          slug: model,
          name: "GPT-5.5",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ]),
              selectDescriptor("serviceTier", "Speed", [
                { id: "default", label: "Standard", isDefault: true },
                { id: "priority", label: "Fast" },
              ]),
            ],
          }),
        },
      ],
    });

    await page.getByRole("button", { name: /Medium/ }).click();

    const fastModeToggle = page.getByRole("menuitemcheckbox", { name: "Fast Mode" });
    await expect.element(fastModeToggle).toBeInTheDocument();
    await expect.element(fastModeToggle).toHaveAttribute("aria-checked", "false");
    await expect
      .element(page.getByRole("menuitemradio", { name: "Standard default" }))
      .not.toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("Speed");

    await fastModeToggle.click();

    await vi.waitFor(() => {
      expect(mounted.changes.at(-1)).toContainEqual({ id: "serviceTier", value: "priority" });
    });
  });

  it("says what each speed costs when a model offers three of them", async () => {
    const provider = ProviderDriverKind.make("codex");
    const model = "gpt-6-astra";
    await using _mounted = await mountTraitsPicker({
      provider,
      model,
      models: [
        {
          slug: model,
          name: "GPT-6-Astra",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "Low", description: "Faster, lighter reasoning." },
                { id: "medium", label: "Medium", isDefault: true },
              ]),
              selectDescriptor("serviceTier", "Speed", [
                { id: "default", label: "Standard", isDefault: true },
                { id: "priority", label: "Fast", description: "2x speed, increased usage" },
                { id: "ultrafast", label: "Ultrafast", description: "8x speed, increased usage" },
              ]),
            ],
          }),
        },
      ],
    });

    await page.getByRole("button", { name: /Medium/ }).click();

    await expect
      .element(page.getByRole("menuitemradio", { name: /Ultrafast/ }))
      .toHaveTextContent("8x speed, increased usage");
    await expect
      .element(page.getByRole("menuitemradio", { name: /Fast/ }).first())
      .toHaveTextContent("2x speed, increased usage");
    expect(document.body.textContent ?? "").not.toContain("Faster, lighter reasoning.");
  });

  it("shows active fast mode as a compact accent zap in the traits trigger", async () => {
    const provider = ProviderDriverKind.make("codex");
    const model = "gpt-5.5";
    await using _ = await mountTraitsPicker({
      provider,
      model,
      modelOptions: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
      models: [
        {
          slug: model,
          name: "GPT-5.5",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ],
    });

    const trigger = page.getByRole("button", { name: /High/ });
    await expect.element(trigger).toBeInTheDocument();

    const triggerElement = trigger.element();
    expect(triggerElement.textContent ?? "").toContain("Fast Mode enabled");
    expect(triggerElement.textContent ?? "").not.toContain("+1");
    const zapIcon = triggerElement.querySelector("svg.lucide-zap");
    expect(zapIcon).not.toBeNull();
    expect(zapIcon?.getAttribute("class") ?? "").toContain("text-primary-readable");
  });

  it("keeps a saved Ultracode level running as Extra High with its own switch", async () => {
    await using mounted = await mountTraitsPicker(
      ultracodeModelProps([{ id: "effort", value: "ultracode" }]),
    );

    const trigger = page.getByRole("button", { name: /Extra High/ });
    await expect.element(trigger).toBeInTheDocument();
    const triggerElement = trigger.element();
    expect(triggerElement.className).toContain("ultracode-trait-trigger");
    expect(triggerElement.textContent ?? "").toContain("Ultracode on");
    expect(triggerElement.textContent ?? "").not.toContain("+1");

    await trigger.click();
    const ultracodeToggle = page.getByRole("menuitemcheckbox", { name: "Ultracode" });
    await expect.element(ultracodeToggle).toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("menuitemradio", { name: "Ultracode" }))
      .not.toBeInTheDocument();

    await ultracodeToggle.click();
    await vi.waitFor(() => {
      expect(mounted.changes.at(-1)).toEqual([
        { id: "effort", value: "xhigh" },
        { id: "ultracode", value: false },
      ]);
    });
  });

  it("keeps Extra High when a menu leaves out an older CLI's Ultracode level", async () => {
    const props = ultracodeModelProps([{ id: "effort", value: "ultracode" }]);
    const legacyModels = props.models.map((model) => ({
      ...model,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("effort", "Reasoning", [
            { id: "high", label: "High", isDefault: true },
            { id: "xhigh", label: "Extra High" },
            { id: "ultracode", label: "Ultracode" },
          ]),
        ],
      }),
    }));
    await using _ = await mountTraitsPicker({
      ...props,
      models: legacyModels,
      omitOptionIds: ["ultracode"],
    });

    const trigger = page.getByRole("button", { name: /Extra High/ });
    await expect.element(trigger).toBeInTheDocument();
    expect(trigger.element().className).not.toContain("ultracode-trait-trigger");
    await trigger.click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Ultracode" }))
      .not.toBeInTheDocument();
  });

  it("glints the Ultracode trigger only while Claude works", async () => {
    const options = [
      { id: "effort", value: "medium" },
      { id: "ultracode", value: true },
    ];
    const idle = await mountTraitsPicker(ultracodeModelProps(options));
    const idleBand = document.querySelector(".ultracode-glint-band");
    expect(idleBand).not.toBeNull();
    expect(idleBand?.getAnimations()).toHaveLength(0);
    await idle.cleanup();

    await using _ = await mountTraitsPicker({ ...ultracodeModelProps(options), working: true });
    await vi.waitFor(() => {
      expect(document.querySelector(".ultracode-glint-band")?.getAnimations().length).toBe(1);
    });
  });

  it("shrinks the reasoning trigger to its icon while preserving its menu", async () => {
    const provider = ProviderDriverKind.make("codex");
    const model = "gpt-5.5";
    await using _ = await mountTraitsPicker({
      provider,
      model,
      iconOnly: true,
      models: [
        {
          slug: model,
          name: "GPT-5.5",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ]),
            ],
          }),
        },
      ],
    });

    const trigger = page.getByRole("button", { name: "Reasoning settings: Medium" });
    await expect.element(trigger).toBeInTheDocument();
    expect(trigger.element().getBoundingClientRect().width).toBeLessThanOrEqual(32);
    await trigger.click();
    await expect.element(page.getByRole("menuitemradio", { name: "High" })).toBeInTheDocument();
  });

  it("hides fast mode controls for non-Opus Claude models", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
      ),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
      ),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).not.toContain("Max");
    });
  });

  it("shows Claude thinking as a single switch for Haiku", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-haiku-4-5",
        [{ id: "thinking", value: true }],
      ),
    });

    await page.getByLabelText("More composer controls").click();

    const thinkingToggle = page.getByRole("menuitemcheckbox", { name: "Thinking" });
    await expect.element(thinkingToggle).toBeInTheDocument();
    await expect.element(thinkingToggle).toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByRole("menuitemradio", { name: "On" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("menuitemradio", { name: "Off" })).not.toBeInTheDocument();
  });

  it("can hide the interaction mode section", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <CompactComposerControlsMenu
        interactionMode="default"
        runtimeMode="approval-required"
        runtimeModeOptions={TEST_RUNTIME_MODE_OPTIONS}
        showInteractionModeToggle={false}
        onInteractionModeChange={vi.fn()}
        onRuntimeModeChange={vi.fn()}
      />,
      { container: host },
    );

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).not.toContain("Mode");
      expect(text).not.toContain("Chat");
      expect(text).not.toContain("Build");
      expect(text).not.toContain("Plan");
      expect(text).toContain("Access");
      expect(text).toContain("Supervised");
      expect(text).toContain("Full access");
    });

    await screen.unmount();
    host.remove();
  });

  it("uses the same interaction labels as the expanded composer", async () => {
    await using _ = await mountMenu();

    await page.getByLabelText("More composer controls").click();

    await expect.element(page.getByRole("menuitemradio", { name: "Build" })).toBeInTheDocument();
    await expect.element(page.getByRole("menuitemradio", { name: "Plan" })).toBeInTheDocument();
    await expect.element(page.getByRole("menuitemradio", { name: "Chat" })).not.toBeInTheDocument();
  });

  it("shows the same mode and access icons as the expanded composer", async () => {
    await using _ = await mountMenu();

    await page.getByLabelText("More composer controls").click();

    await expect.element(page.getByRole("menuitemradio", { name: "Build" })).toBeInTheDocument();
    expect(document.body.querySelector("svg.lucide-hammer")).not.toBeNull();
    expect(document.body.querySelector("svg.lucide-list-todo")).not.toBeNull();
    expect(document.body.querySelector("svg.lucide-lock")).not.toBeNull();
    expect(document.body.querySelector("svg.lucide-pen-line")).not.toBeNull();
    expect(document.body.querySelector("svg.lucide-lock-open")).not.toBeNull();
  });
});
