/**
 * MuseAdapter — shape type for the Muse Code provider adapter. The driver
 * ({@link ../Drivers/MuseDriver}) bundles one adapter per instance as a
 * captured closure; this names its shape.
 *
 * @module MuseAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/** Per-instance Muse Code adapter contract. */
export interface MuseAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
