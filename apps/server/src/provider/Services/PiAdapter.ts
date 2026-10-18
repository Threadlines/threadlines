/**
 * PiAdapter — shape type for the Pi provider adapter. The driver
 * ({@link ../Drivers/PiDriver}) bundles one adapter per instance as a
 * captured closure; this names its shape.
 *
 * @module PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/** Per-instance Pi adapter contract. */
export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
