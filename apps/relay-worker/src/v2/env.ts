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
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
  };
}

export function ledgerLimitsFromEnv(env: RelayV2Env): LedgerLimits {
  return {
    dailyMessageBudget: positiveInt(env.THREADLINES_RELAY_DAILY_MESSAGE_BUDGET, 1_200_000),
    registrationsPerIpPerDay: positiveInt(env.THREADLINES_RELAY_REGISTRATIONS_PER_IP_PER_DAY, 20),
  };
}

/** The relay's public origin, for addresses it hands out (`THREADLINES_RELAY_PUBLIC_ORIGIN`, else the request's). */
export function publicRelayOrigin(request: Request, env: RelayV2Env): string {
  return env.THREADLINES_RELAY_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
}
