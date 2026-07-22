import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const evidence = z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).min(1);

const changelog = defineCollection({
  loader: glob({
    base: "./src/content/changelog",
    pattern: "**/*.md",
    generateId: ({ data, entry }) =>
      typeof data.version === "string" ? `v${data.version}` : entry.replace(/\.md$/, ""),
  }),
  schema: z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    date: z.coerce.date(),
    title: z.string().min(1).max(90),
    summary: z.string().min(1).max(280),
    githubRelease: z.url(),
    highlights: z
      .array(
        z.object({
          title: z.string().min(1).max(70),
          description: z.string().min(1).max(420),
          evidence,
        }),
      )
      .min(2)
      .max(5),
    alsoImproved: z
      .array(
        z.object({
          description: z.string().min(1).max(180),
          evidence,
        }),
      )
      .max(6)
      .default([]),
    social: z.string().min(1).max(260),
  }),
});

export const collections = { changelog };
