// @effect-diagnostics globalDate:off
import { DurableObject } from "cloudflare:workers";

import type { RelayV2Env } from "../env.ts";
import { assistantCodeShardName } from "./codes.ts";
import {
  type CodeTypingOutcome,
  type NewSignIn,
  SignInCore,
  type SignInStatus,
  typeAssistantCode,
} from "./signIns.ts";

/**
 * One of 32 shards of pending assistant sign-ins (`assistant-sign-ins:<n>`),
 * host independent: a sign-in lives here from the moment the assistant opens
 * the page, before anyone knows which computer it is for. Once the page's
 * code matches, the computer's `RelayHost` shows it and sends the decision
 * back here. The alarm ends sign-ins whose 10 minutes are up.
 */
export class RelayAssistantSignIn extends DurableObject<RelayV2Env> {
  private readonly core: SignInCore;

  constructor(ctx: DurableObjectState, env: RelayV2Env) {
    super(ctx, env);
    this.core = new SignInCore(ctx.storage.sql);
  }

  async create(
    input: NewSignIn,
  ): Promise<{ readonly ok: true; readonly expiresAt: number } | { readonly ok: false }> {
    const created = this.core.create(input, Date.now());
    if (created.ok) await this.scheduleAlarm();
    return created;
  }

  async status(input: {
    readonly signInId: string;
    readonly pageSecretHash: string;
  }): Promise<SignInStatus> {
    return this.core.status(input.signInId, input.pageSecretHash, Date.now());
  }

  async typeCode(input: {
    readonly signInId: string;
    readonly pageSecretHash: string;
    readonly code: string;
  }): Promise<CodeTypingOutcome> {
    return typeAssistantCode(
      this.core,
      {
        takeCode: (code) =>
          this.env.RELAY_CODE_SHARD.getByName(assistantCodeShardName(code)).takeAssistantCode(code),
        handToHost: (hostId, signIn, code) =>
          this.env.RELAY_HOST.getByName(hostId).beginAssistantSignIn({ hostId, signIn, code }),
        now: () => Date.now(),
      },
      input,
    );
  }

  /** From the computer's `RelayHost`, with the decision it got on the assistant socket. */
  async decide(input: {
    readonly signInId: string;
    readonly hostId: string;
    readonly decision: "allow" | "deny";
    readonly authorizationCode?: string;
  }): Promise<"applied" | "expired" | "gone"> {
    const outcome = this.core.decide(input, Date.now());
    if (outcome === "applied") await this.scheduleAlarm();
    return outcome;
  }

  override async alarm(): Promise<void> {
    this.core.expireDue(Date.now());
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const next = this.core.nextDeadline();
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}
