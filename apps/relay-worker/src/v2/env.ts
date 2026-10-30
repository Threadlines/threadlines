import type { HostCoreLimits } from "./hostCore.ts";
import { DEFAULT_HOST_CORE_LIMITS } from "./hostCore.ts";
import type { LedgerLimits } from "./ledgerCore.ts";

/** Bindings and vars the v2 relay reads (see wrangler.jsonc). */
export type RelayV2Env = Env & {
  readonly RELAY_MESSAGE_RATE_LIMITER: RateLimit;
  readonly SESSION_CREATE_RATE_LIMITER: RateLimit;
  readonly JOIN_RATE_LIMITER: RateLimit;
  readonly CONTROL_RATE_LIMITER: RateLimit;
  /** Event task deliveries: per client IP, per hook, and the host's acknowledgements. */
  readonly HOOK_IP_RATE_LIMITER: RateLimit;
  readonly HOOK_RATE_LIMITER: RateLimit;
  readonly HOOK_ACK_RATE_LIMITER: RateLimit;
  /** Secret (`wrangler secret put HOOK_PATH_KEY`): keys the mac in hook addresses. Unset: no hooks. */
  readonly HOOK_PATH_KEY?: string;
  readonly RELAY_HOST: DurableObjectNamespace<import("./RelayHost.ts").RelayHost>;
  readonly RELAY_CODE_SHARD: DurableObjectNamespace<import("./RelayCodeShard.ts").RelayCodeShard>;
  readonly RELAY_LEDGER: DurableObjectNamespace<import("./RelayLedger.ts").RelayLedger>;
  readonly THREADLINES_RELAY_V2_ENABLED?: string;
  readonly THREADLINES_RELAY_HOST_DAILY_MESSAGES?: string;
  readonly THREADLINES_RELAY_HOST_DAILY_AWAKE_SECONDS?: string;
  readonly THREADLINES_RELAY_DAILY_MESSAGE_BUDGET?: string;
  readonly THREADLINES_RELAY_REGISTRATIONS_PER_IP_PER_DAY?: string;
  readonly THREADLINES_RELAY_HOST_DAILY_HOOKS?: string;
  /**
   * Secret (`wrangler secret put PUSH_VAPID_KEYS`): the VAPID keys phones
   * subscribe with, a JSON object of P-256 private JWKs by hosted channel
   * (`stable`, `nightly`) plus `retired: [...]` still accepted for sending.
   * Unset: the relay sends no alerts.
   */
  readonly PUSH_VAPID_KEYS?: string;
  /** `false`/`0`/`off` stops all push alerts (a kill switch); anything else leaves them on. */
  readonly THREADLINES_RELAY_PUSH_ENABLED?: string;
  readonly THREADLINES_RELAY_DAILY_ALERT_BUDGET?: string;
  readonly THREADLINES_RELAY_HOST_DAILY_ALERTS?: string;
  /**
   * The assistants door (docs/design/assistants.md; assistants/config.ts).
   * `ASSISTANTS_ORIGIN` is its public origin (`https://connect.threadlines.dev`,
   * or loopback http for a local relay); `ASSISTANTS_ENABLED=false` is its kill
   * switch. The two keys are secrets, base64url of at least 32 random bytes,
   * and permanent: changing the route key breaks every connection, changing
   * the client key every registered client.
   */
  readonly ASSISTANTS_ORIGIN?: string;
  readonly ASSISTANTS_ENABLED?: string;
  readonly ASSISTANT_ROUTE_KEY?: string;
  readonly ASSISTANT_CLIENT_KEY?: string;
  readonly THREADLINES_RELAY_HOST_DAILY_ASSISTANT_REQUESTS?: string;
  /** Per client IP: registrations, sign-in pages and typed codes (10 a minute). */
  readonly ASSISTANT_SIGN_IN_RATE_LIMITER: RateLimit;
  /** Per client IP: sign-in pages polling for the computer's decision. */
  readonly ASSISTANT_STATUS_RATE_LIMITER: RateLimit;
  /** Per connection (`mcp:` and `token:` keys): 120 a minute, the computer's own rate. */
  readonly ASSISTANT_CONNECTION_RATE_LIMITER: RateLimit;
  readonly RELAY_ASSISTANT_SIGN_IN: DurableObjectNamespace<
    import("./assistants/RelayAssistantSignIn.ts").RelayAssistantSignIn
  >;
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Whether the relay sends push alerts at all (the kill switch); keys are checked separately. */
export function isPushEnabled(env: RelayV2Env): boolean {
  const configured = env.THREADLINES_RELAY_PUSH_ENABLED?.trim().toLowerCase();
  return configured !== "false" && configured !== "0" && configured !== "off";
}

export function isRelayV2Enabled(env: RelayV2Env): boolean {
  const configured = env.THREADLINES_RELAY_V2_ENABLED?.trim().toLowerCase();
  return configured !== "false" && configured !== "0" && configured !== "off";
}

export function hostLimitsFromEnv(env: RelayV2Env): HostCoreLimits {
  return {
    ...DEFAULT_HOST_CORE_LIMITS,
    dailyMessages: positiveInt(
      env.THREADLINES_RELAY_HOST_DAILY_MESSAGES,
      DEFAULT_HOST_CORE_LIMITS.dailyMessages,
    ),
    dailyAwakeSeconds: positiveInt(
      env.THREADLINES_RELAY_HOST_DAILY_AWAKE_SECONDS,
      DEFAULT_HOST_CORE_LIMITS.dailyAwakeSeconds,
    ),
    dailyHooks: positiveInt(
      env.THREADLINES_RELAY_HOST_DAILY_HOOKS,
      DEFAULT_HOST_CORE_LIMITS.dailyHooks,
    ),
    dailyAlerts: positiveInt(
      env.THREADLINES_RELAY_HOST_DAILY_ALERTS,
      DEFAULT_HOST_CORE_LIMITS.dailyAlerts,
    ),
  };
}

export function ledgerLimitsFromEnv(env: RelayV2Env): LedgerLimits {
  return {
    dailyMessageBudget: positiveInt(env.THREADLINES_RELAY_DAILY_MESSAGE_BUDGET, 1_200_000),
    registrationsPerIpPerDay: positiveInt(env.THREADLINES_RELAY_REGISTRATIONS_PER_IP_PER_DAY, 20),
    dailyAlertBudget: positiveInt(env.THREADLINES_RELAY_DAILY_ALERT_BUDGET, 50_000),
  };
}

/** The relay's public origin, for addresses it hands out (`THREADLINES_RELAY_PUBLIC_ORIGIN`, else the request's). */
export function publicRelayOrigin(request: Request, env: RelayV2Env): string {
  return env.THREADLINES_RELAY_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
}
