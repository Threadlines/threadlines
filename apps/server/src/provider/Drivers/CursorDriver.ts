/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent (`agent acp`) runtime.
 *
 * Everything Cursor-specific lives in `acp/CursorAcpSupport.ts`; this is the
 * generic ACP driver applied to that descriptor.
 *
 * @module provider/Drivers/CursorDriver
 */
import { CURSOR_ACP_DESCRIPTOR } from "../acp/CursorAcpSupport.ts";
import { makeAcpProviderDriver, type AcpProviderDriverEnv } from "../acp/AcpProviderDriver.ts";

export type CursorDriverEnv = AcpProviderDriverEnv;

export const CursorDriver = makeAcpProviderDriver(CURSOR_ACP_DESCRIPTOR);
