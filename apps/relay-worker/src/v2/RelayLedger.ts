// @effect-diagnostics globalDate:off
import { DurableObject } from "cloudflare:workers";

import { ledgerLimitsFromEnv, type RelayV2Env } from "./env.ts";
import { LedgerCore } from "./ledgerCore.ts";

/** Singleton relay-wide budget (`getByName("ledger")`). */
export class RelayLedger extends DurableObject<RelayV2Env> {
  private readonly core: LedgerCore;

  constructor(ctx: DurableObjectState, env: RelayV2Env) {
    super(ctx, env);
    this.core = new LedgerCore(ctx.storage.sql, ledgerLimitsFromEnv(env));
  }

  async report(messages: number): Promise<{ readonly busy: boolean }> {
    return this.core.report(messages, Date.now());
  }

  async isBusy(): Promise<boolean> {
    return this.core.isBusy(Date.now());
  }

  async allowRegistration(ipHash: string): Promise<boolean> {
    return this.core.allowRegistration(ipHash, Date.now());
  }
}

export const RELAY_LEDGER_NAME = "ledger";
