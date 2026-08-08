import { CommandId, MessageId, ProjectId, ThreadId } from "@threadlines/contracts";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import { randomUUIDv4Sync } from "@threadlines/shared/uuid";
import { DraftId } from "../composerDraftStore";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isLinuxPlatform(platform: string): boolean {
  return /linux/i.test(platform);
}

/**
 * Single UUID entry point for the web bundle. `crypto.randomUUID` is missing in
 * insecure contexts (a phone paired over plain `http://<lan-ip>`), so every
 * call site goes through the shared helper's `getRandomValues` fallback.
 */
export const randomUUID = randomUUIDv4Sync;

export const newCommandId = (): CommandId => CommandId.make(randomUUID());

export const newProjectId = (): ProjectId => ProjectId.make(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.make(randomUUID());

export const newDraftId = (): DraftId => DraftId.make(randomUUID());

export const newMessageId = (): MessageId => MessageId.make(randomUUID());
