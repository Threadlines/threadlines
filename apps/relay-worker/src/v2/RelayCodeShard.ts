// @effect-diagnostics globalDate:off
import { DurableObject } from "cloudflare:workers";

import { AssistantCodeShardCore } from "./assistants/codes.ts";
import { CodeShardCore } from "./codeShardCore.ts";
import type { RelayV2Env } from "./env.ts";

/**
 * Keeps live codes unique: Connect a device's 6-digit codes (ten shards,
 * `codes:<last digit>`) and assistants' sign-in codes (32 shards,
 * `assistant-codes:<last character>`). Each object only ever holds one kind,
 * by its name, but both tables are there.
 */
export class RelayCodeShard extends DurableObject<RelayV2Env> {
  private readonly core: CodeShardCore;
  private readonly assistantCodes: AssistantCodeShardCore;

  constructor(ctx: DurableObjectState, env: RelayV2Env) {
    super(ctx, env);
    this.core = new CodeShardCore(ctx.storage.sql);
    this.assistantCodes = new AssistantCodeShardCore(ctx.storage.sql);
  }

  async claim(input: {
    readonly code: string;
    readonly hostId: string;
    readonly inviteId: string;
    readonly expiresAt: number;
  }): Promise<boolean> {
    const claimed = this.core.claim({ ...input, now: Date.now() });
    if (claimed) {
      await this.scheduleSweep();
    }
    return claimed;
  }

  async lookup(
    code: string,
  ): Promise<{ readonly hostId: string; readonly inviteId: string } | null> {
    return this.core.lookup(code, Date.now());
  }

  async release(input: {
    readonly code: string;
    readonly hostId: string;
    readonly inviteId: string;
  }): Promise<void> {
    this.core.release(input);
  }

  // ----- assistant sign-in codes ------------------------------------------------

  async claimAssistantCode(input: {
    readonly code: string;
    readonly hostId: string;
    readonly expiresAt: number;
  }): Promise<boolean> {
    const claimed = this.assistantCodes.claim({ ...input, now: Date.now() });
    if (claimed) await this.scheduleSweep();
    return claimed;
  }

  /** Uses a typed code up; the host it belonged to, or null. */
  async takeAssistantCode(code: string): Promise<string | null> {
    return this.assistantCodes.take(code, Date.now());
  }

  async releaseAssistantCode(input: {
    readonly code: string;
    readonly hostId: string;
  }): Promise<void> {
    this.assistantCodes.release(input);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.core.sweep(now);
    this.assistantCodes.sweep(now);
    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    const deadlines = [this.core.nextExpiry(), this.assistantCodes.nextExpiry()].filter(
      (deadline): deadline is number => deadline !== null,
    );
    if (deadlines.length === 0) {
      return;
    }
    const next = Math.min(...deadlines);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}
