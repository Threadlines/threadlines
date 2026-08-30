/**
 * FxDriver — `ProviderDriver` for fx (`fx acp`, https://fx.sh).
 *
 * Everything fx-specific lives in `acp/FxAcpSupport.ts`; this is the generic
 * ACP driver applied to that descriptor.
 *
 * @module provider/Drivers/FxDriver
 */
import { FX_ACP_DESCRIPTOR } from "../acp/FxAcpSupport.ts";
import { makeAcpProviderDriver, type AcpProviderDriverEnv } from "../acp/AcpProviderDriver.ts";

export type FxDriverEnv = AcpProviderDriverEnv;

export const FxDriver = makeAcpProviderDriver(FX_ACP_DESCRIPTOR);
