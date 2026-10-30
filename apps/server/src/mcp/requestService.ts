import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Reads a service that an MCP route's sign-in middleware provides for each
 * request (who is calling), off the calling fiber.
 *
 * Tool handlers run with their request's services. Effect still counts every
 * service a tool or handler names as something the toolkit layer needs when
 * it is built, before any request exists, and providing one there would be
 * wrong: the toolkit lays its build-time services over each call's, so every
 * call would look like the same caller. Read through this, the service stays
 * a per-request one and out of the layer's requirements.
 */
export const requestService = <I, S>(key: Context.Key<I, S>): Effect.Effect<S> =>
  Effect.withFiber((fiber) =>
    Effect.succeed(Context.getUnsafe(fiber.context as Context.Context<I>, key)),
  );
