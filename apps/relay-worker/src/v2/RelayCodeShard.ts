// @effect-diagnostics globalDate:off
import { DurableObject } from "cloudflare:workers";

import { CodeShardCore } from "./codeShardCore.ts";
import type { RelayV2Env } from "./env.ts";

/** One of ten shards that keep live 6-digit codes unique. */
export class RelayCodeShard extends DurableObject<RelayV2Env> {
  private readonly core: CodeShardCore;

  constructor(ctx: DurableObjectState, env: RelayV2Env) {
    super(ctx, env);
    this.core = new CodeShardCore(ctx.storage.sql);
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

  override async alarm(): Promise<void> {
    this.core.sweep(Date.now());
    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    const next = this.core.nextExpiry();
    if (next === null) {
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}
