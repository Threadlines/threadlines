/**
 * MCP Events on the assistants door (docs/design/assistants.md, "Build plan:
 * step 5"): what `events/list` offers, and `events/subscribe` and
 * `events/unsubscribe` read off the wire, with the caller's project resolved
 * against its live grant. The subscriptions themselves are AssistantAlerts'.
 *
 * Any access level may list and subscribe: an event says no more than `inbox`
 * does. A subscription's identity comes from its arguments as sent; what they
 * resolve to is kept apart, so a renamed project doesn't break an unsubscribe.
 */
import type { ProjectId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import {
  type ConnectProject,
  findProject,
  projectsIn,
} from "../outsideAgents/connectToolHandlers.ts";
import type {
  OutsideAgentCaller,
  OutsideAgentConnectionsShape,
} from "../outsideAgents/OutsideAgentConnections.ts";
import {
  type AssistantAlertsShape,
  type AssistantSubscriptionError,
  SUBSCRIBE_ERROR,
} from "./AssistantAlerts.ts";
import type { AssistantEventName } from "./AssistantEvents.ts";
import type { AssistantMcpEvents, AssistantMcpEventsAnswer, JsonObject } from "./AssistantMcp.ts";
import { parseWebhookSecret } from "./webhookSigning.ts";

const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;

const SUBSCRIBE_ARGUMENTS = {
  type: "object",
  properties: {
    project: {
      type: "string",
      description: "A project's id or name. Leave it out for every project you can see.",
    },
  },
  additionalProperties: false,
};

/** The `data` every event carries: what Threadlines or the user wrote, never an agent's text. */
const EVENT_DATA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["needs_you", "finished", "failed"] },
    reason: { type: "string", description: "Why: approval, question, plan, finished, error..." },
    threadId: { type: "string" },
    projectId: { type: "string" },
    project: { type: ["string", "null"], description: "The project's name." },
    computer: { type: "string", description: "The computer the thread runs on." },
    link: { type: "string", description: "Opens the thread in Threadlines." },
    at: { type: "string", description: "When it happened." },
  },
  required: ["kind", "reason", "threadId", "projectId", "project", "computer", "link", "at"],
};

const CATALOG: ReadonlyArray<{ readonly name: AssistantEventName; readonly description: string }> =
  [
    {
      name: "thread.needs_you",
      description: "A thread is waiting on the user: an approval, a question or a plan.",
    },
    { name: "thread.finished", description: "A thread's agent finished its turn." },
    { name: "thread.failed", description: "A thread's agent stopped on an error." },
  ];

const LISTING = CATALOG.map((event) => ({
  ...event,
  delivery: ["webhook"],
  inputSchema: SUBSCRIBE_ARGUMENTS,
  payloadSchema: EVENT_DATA,
}));

const isEventName = (name: string): name is AssistantEventName =>
  CATALOG.some((event) => event.name === name);

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (code: number, message: string): AssistantMcpEventsAnswer => ({
  error: { code, message },
});
const invalid = (message: string) => fail(SUBSCRIBE_ERROR.invalidParams, message);

const asAnswer = (error: AssistantSubscriptionError): AssistantMcpEventsAnswer => ({
  error: {
    code: error.code,
    message: error.message,
    ...(error.reason !== undefined ? { data: { reason: error.reason } } : {}),
  },
});

/** The subscribe arguments: an optional project and nothing else, as canonical JSON. */
const readArguments = (value: unknown) => {
  if (value !== undefined && !isObject(value)) return null;
  const { project, ...rest } = value ?? {};
  if (Object.keys(rest).length > 0) return null;
  if (project !== undefined && typeof project !== "string") return null;
  return { project, argumentsJson: JSON.stringify(project === undefined ? {} : { project }) };
};

/** The callback's address, normalized, so one address always makes the same id. */
const normalizedUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value.trim()).href;
  } catch {
    return null;
  }
};

/** `whsec_` and 24 to 64 bytes of base64. */
const readSecret = (value: unknown) => {
  if (typeof value !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const bytes = parseWebhookSecret(value);
  return bytes.length >= SECRET_MIN_BYTES && bytes.length <= SECRET_MAX_BYTES ? bytes : null;
};

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export const makeAssistantMcpEvents = (deps: {
  readonly alerts: Pick<AssistantAlertsShape, "subscribe" | "unsubscribe">;
  readonly grantOf: OutsideAgentConnectionsShape["grant"];
  readonly projects: Effect.Effect<ReadonlyArray<ConnectProject>>;
}): AssistantMcpEvents => {
  const list = (caller: OutsideAgentCaller) =>
    Effect.map(deps.grantOf(caller.connectionId), (grant) => (grant === null ? [] : LISTING));

  const subscribe: AssistantMcpEvents["subscribe"] = (caller, params) =>
    Effect.gen(function* () {
      const grant = yield* deps.grantOf(caller.connectionId);
      if (grant === null) {
        return fail(SUBSCRIBE_ERROR.forbidden, "This connection can't subscribe any more.");
      }
      const name = params?.name;
      if (typeof name !== "string") return invalid("events/subscribe needs the event's name.");
      if (!isEventName(name)) {
        return fail(SUBSCRIBE_ERROR.eventNotFound, `There is no event called ${name}.`);
      }
      const args = readArguments(params?.arguments);
      if (args === null) {
        return invalid("The arguments can only have project, a project's id or name.");
      }
      const reachable = projectsIn(yield* deps.projects, grant);
      let projectIds: ReadonlyArray<ProjectId> | null = null;
      if (args.project !== undefined) {
        const found = findProject(reachable, args.project);
        if ("detail" in found) return fail(SUBSCRIBE_ERROR.forbidden, found.detail);
        projectIds = [found.project.id];
      }
      const delivery = params?.delivery;
      if (!isObject(delivery) || delivery.mode !== "webhook") {
        return invalid('delivery needs mode "webhook".');
      }
      const url = normalizedUrl(delivery.url);
      if (url === null) return invalid("delivery.url isn't a web address.");
      const secret = readSecret(delivery.secret);
      if (secret === null) {
        return invalid(
          `delivery.secret needs whsec_ and ${SECRET_MIN_BYTES} to ${SECRET_MAX_BYTES} bytes of base64.`,
        );
      }
      const { cursor, ttlMs, maxAgeMs } = params ?? {};
      if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
        return invalid("cursor must be the text an earlier answer gave.");
      }
      if (ttlMs !== undefined && ttlMs !== null && !isTime(ttlMs)) {
        return invalid("ttlMs must be a number of milliseconds.");
      }
      if (maxAgeMs !== undefined && !isTime(maxAgeMs)) {
        return invalid("maxAgeMs must be a number of milliseconds.");
      }
      const result = yield* deps.alerts.subscribe({
        connectionId: caller.connectionId,
        url,
        name,
        argumentsJson: args.argumentsJson,
        projectIds,
        reachableProjectIds: reachable.map((project) => project.id),
        secret,
        cursor: cursor ?? null,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
      });
      return { result: { ...result } };
    }).pipe(
      Effect.catchTag("AssistantSubscriptionError", (error) => Effect.succeed(asAnswer(error))),
    );

  const unsubscribe: AssistantMcpEvents["unsubscribe"] = (caller, params) =>
    Effect.gen(function* () {
      const name = params?.name;
      if (typeof name !== "string") return invalid("events/unsubscribe needs the event's name.");
      const args = readArguments(params?.arguments);
      if (args === null) {
        return invalid("The arguments can only have project, a project's id or name.");
      }
      const delivery = params?.delivery;
      if (!isObject(delivery)) return invalid("events/unsubscribe needs delivery.url.");
      const url = normalizedUrl(delivery.url);
      if (url === null) return invalid("delivery.url isn't a web address.");
      // An event that doesn't exist has no subscriptions, and this answers the same either way.
      if (isEventName(name)) {
        yield* deps.alerts.unsubscribe({
          connectionId: caller.connectionId,
          url,
          name,
          argumentsJson: args.argumentsJson,
        });
      }
      return { result: {} };
    }).pipe(
      Effect.catchTag("AssistantSubscriptionError", (error) => Effect.succeed(asAnswer(error))),
    );

  return { list, subscribe, unsubscribe };
};
