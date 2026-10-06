import { describe, expect, it } from "vite-plus/test";

import { boundAcpRegistryModels } from "./AcpRegistryAgentState.ts";

type Models = Parameters<typeof boundAcpRegistryModels>[0];

describe("boundAcpRegistryModels", () => {
  it("keeps an agent's catalog as it is when it is of ordinary size", () => {
    const models = [
      {
        slug: "glm-5.3",
        name: "GLM-5.3",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "mode",
              label: "Mode",
              type: "select",
              options: [
                { id: "ask", label: "Ask for permission", isDefault: true },
                { id: "auto", label: "Auto-approve edits", description: "Edits apply at once." },
              ],
              currentValue: "ask",
            },
            { id: "fast", label: "Fast", type: "boolean", currentValue: false },
          ],
        },
      },
    ] as unknown as Models;
    expect(boundAcpRegistryModels(models)).toEqual(models);
  });

  it("cuts down a catalog no person would read", () => {
    const long = "x".repeat(50_000);
    const models = [
      {
        slug: "big",
        name: long,
        description: long,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "mode",
              label: long,
              description: long,
              type: "select",
              options: Array.from({ length: 5000 }, (_, index) => ({
                id: `choice-${index}`,
                label: long,
                description: long,
              })),
              // Not among the choices that are kept.
              currentValue: "choice-4999",
            },
            // An id too long to be one.
            { id: long, label: "Odd", type: "boolean" },
            ...Array.from({ length: 500 }, (_, index) => ({
              id: `option-${index}`,
              label: "Option",
              type: "boolean",
            })),
          ],
        },
      },
      { slug: long, name: "No such model", isCustom: false, capabilities: null },
      ...Array.from({ length: 1000 }, (_, index) => ({
        slug: `model-${index}`,
        name: "Model",
        isCustom: false,
        capabilities: null,
      })),
    ] as unknown as Models;

    const bounded = boundAcpRegistryModels(models);

    expect(bounded).toHaveLength(200);
    expect(bounded.some((model) => model.slug === long)).toBe(false);
    const [big] = bounded;
    expect(big?.name).toHaveLength(160);
    expect(big?.description).toHaveLength(1024);
    const descriptors = big?.capabilities?.optionDescriptors ?? [];
    expect(descriptors).toHaveLength(32);
    expect(descriptors.some((descriptor) => descriptor.id === long)).toBe(false);
    const [mode] = descriptors;
    expect(mode?.label).toHaveLength(160);
    expect(mode?.type === "select" ? mode.options : []).toHaveLength(200);
    expect(mode?.type === "select" ? mode.currentValue : "unset").toBeUndefined();
    // All of it together is small enough to save and to send.
    expect(JSON.stringify(bounded).length).toBeLessThan(400_000);
  });
});
