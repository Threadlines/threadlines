/**
 * The app guide behind `app_guide` (docs/design/app-guide.md): answers an
 * agent's question about Threadlines itself from the place catalog and the
 * topics, in markdown, with this computer's current values for the places
 * that have one.
 *
 * Two steps, so values are read only when an answer shows them: `planGuide`
 * picks what to show and says which values it needs (pure); the caller reads
 * those and `renderGuide` writes the answer (pure).
 */
import {
  type ComputerLinkAccess,
  type RuntimeMode,
  type ServerSettings,
} from "@threadlines/contracts";
import {
  APP_PLACES,
  type AppPlace,
  COMPUTER_LINK_ACCESS_LABELS,
  type PlaceId,
  placeChain,
  placeMarkdownLink,
} from "@threadlines/shared/appPlaces";
import { searchWords } from "@threadlines/shared/placeSearch";
import { RUNTIME_MODE_LABELS } from "@threadlines/shared/runtimeMode";

import { GUIDE_TOPICS, type GuideTopic } from "./topics.ts";

/** The record-backed values a place can show (AppPlaceValue `state`). */
export type GuideState = "linkedComputers" | "providers" | "outsideAgents" | "scheduledTasks";

/** What a link lets one computer's agents do on the other. */
export interface GuideLinkAccess {
  readonly access: ComputerLinkAccess;
  readonly maxRuntimeMode: RuntimeMode;
}

export interface GuideLinkedComputer {
  readonly name: string;
  readonly reachable: boolean;
  /** What its agents may do here, as this computer stores it; null when it has no link here. */
  readonly theirAgentsHere: GuideLinkAccess | null;
  /** What this computer's agents may do there, as that computer last said; null when unknown. */
  readonly ourAgentsThere: (GuideLinkAccess & { readonly fresh: boolean }) | null;
}

/** The values one answer needs; a reader that failed leaves its value out. */
export interface GuideValues {
  readonly computerName: string;
  readonly settings?: ServerSettings;
  readonly linkedComputers?: ReadonlyArray<GuideLinkedComputer>;
  readonly providers?: ReadonlyArray<{
    readonly name: string;
    readonly enabled: boolean;
    readonly signedIn: boolean | null;
  }>;
  readonly outsideAgents?: ReadonlyArray<{ readonly name: string }>;
  readonly scheduledTasks?: { readonly active: number; readonly paused: number };
}

export interface GuideRequest {
  readonly query?: string | undefined;
  readonly topic?: string | undefined;
}

export type GuidePlan =
  | { readonly kind: "index" }
  | { readonly kind: "topic"; readonly topic: GuideTopic }
  | { readonly kind: "unknownTopic"; readonly topic: string }
  | {
      readonly kind: "matches";
      readonly query: string;
      readonly places: ReadonlyArray<AppPlace>;
      readonly topics: ReadonlyArray<GuideTopic>;
    }
  | { readonly kind: "noMatch"; readonly query: string };

/** What an answer needs read: settings, records, or nothing. */
export interface GuideNeeds {
  readonly settings: boolean;
  readonly states: ReadonlySet<GuideState>;
}

const MAX_PLACES = 6;
const MAX_TOPICS = 2;

const STOP_WORDS = new Set(
  "a an and are as at be can could do does for from get go how i if in into is it its let me my of on or should so that the their them there these this to turn up use want was we what when where which who why will with you your".split(
    " ",
  ),
);

/** Settings search's words, less the ones a question carries that name nothing. */
const tokens = (text: string): ReadonlyArray<string> =>
  searchWords(text).filter((word) => word.length > 1 && !STOP_WORDS.has(word));

/** Whether a query word names a word of the text (prefixes count both ways, from 4 letters). */
const mentions = (words: ReadonlyArray<string>, word: string) =>
  words.some(
    (candidate) =>
      candidate === word ||
      (word.length >= 4 && candidate.startsWith(word)) ||
      (candidate.length >= 4 && word.startsWith(candidate)),
  );

interface Weighted {
  readonly words: ReadonlyArray<string>;
  readonly weight: number;
}

const scoreOf = (query: ReadonlyArray<string>, fields: ReadonlyArray<Weighted>) =>
  query.reduce(
    (total, word) =>
      total +
      Math.max(0, ...fields.map((field) => (mentions(field.words, word) ? field.weight : 0))),
    0,
  );

const placeFields = (place: AppPlace): ReadonlyArray<Weighted> => {
  const parents = placeChain(place.id).slice(0, -1);
  return [
    { words: tokens(place.title), weight: 3 },
    { words: tokens(("keywords" in place ? place.keywords : []).join(" ")), weight: 3 },
    { words: tokens(place.about), weight: 1 },
    { words: tokens(parents.map((parent) => parent.title).join(" ")), weight: 1 },
  ];
};

const topicFields = (topic: GuideTopic): ReadonlyArray<Weighted> => [
  { words: tokens(topic.title), weight: 3 },
  { words: tokens(topic.keywords.join(" ")), weight: 3 },
];

/** The best-scoring entries: at least half the top score, at most `limit`. */
function best<T>(
  entries: ReadonlyArray<T>,
  score: (entry: T) => number,
  limit: number,
): ReadonlyArray<T> {
  const scored = entries
    .map((entry) => ({ entry, score: score(entry) }))
    .filter((candidate) => candidate.score > 0)
    .toSorted((left, right) => right.score - left.score);
  const top = scored[0]?.score ?? 0;
  return scored
    .filter((candidate) => candidate.score >= Math.max(2, top / 2))
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}

/** A row or section ranks a little above its page: it says where exactly. */
const KIND_BONUS: Readonly<Record<AppPlace["kind"], number>> = { page: 0, section: 0.25, row: 0.5 };

/** What to answer, and so which values to read. */
export function planGuide(request: GuideRequest): GuidePlan {
  const topicId = request.topic?.trim();
  if (topicId) {
    const topic = GUIDE_TOPICS.find((candidate) => candidate.id === topicId);
    return topic === undefined
      ? { kind: "unknownTopic", topic: topicId }
      : { kind: "topic", topic };
  }
  const query = request.query?.trim() ?? "";
  if (query.length === 0) return { kind: "index" };
  const words = tokens(query);
  const places = best(
    APP_PLACES,
    (place) => {
      const score = scoreOf(words, placeFields(place));
      return score > 0 ? score + KIND_BONUS[place.kind] : 0;
    },
    MAX_PLACES,
  );
  const topics = best(GUIDE_TOPICS, (topic) => scoreOf(words, topicFields(topic)), MAX_TOPICS);
  return places.length === 0 && topics.length === 0
    ? { kind: "noMatch", query }
    : { kind: "matches", query, places, topics };
}

/** Topic text names places as `{place:<id>}`; these are the ids one names. */
export const topicPlaceIds = (body: string): ReadonlyArray<string> =>
  [...body.matchAll(/\{place:([a-zA-Z0-9.]+)\}/gu)].map((match) => match[1]!);

const topicPlaces = (topic: GuideTopic) =>
  topicPlaceIds(topic.body)
    .map((id) => APP_PLACES.find((place) => place.id === id))
    .filter((place): place is AppPlace => place !== undefined);

/** The places whose values an answer shows. */
const shownPlaces = (plan: GuidePlan): ReadonlyArray<AppPlace> =>
  plan.kind === "matches" ? plan.places : plan.kind === "topic" ? topicPlaces(plan.topic) : [];

export function guideNeeds(plan: GuidePlan): GuideNeeds {
  const states = new Set<GuideState>();
  let settings = false;
  for (const place of shownPlaces(plan)) {
    if (!("value" in place)) continue;
    if (place.value.kind === "state") states.add(place.value.state);
    else settings = true;
  }
  return { settings, states };
}

// ----- writing the answer --------------------------------------------------------

const accessWords = (link: GuideLinkAccess) =>
  link.access === "off"
    ? COMPUTER_LINK_ACCESS_LABELS.off
    : `${COMPUTER_LINK_ACCESS_LABELS[link.access]}, up to ${RUNTIME_MODE_LABELS[link.maxRuntimeMode]}`;

/** A place's current value on this computer, in the screen's words; null when it has none to show. */
function valueWords(place: AppPlace, values: GuideValues): string | null {
  if (!("value" in place)) return null;
  const value = place.value;
  switch (value.kind) {
    case "switch":
      return values.settings === undefined ? null : value.read(values.settings) ? "On" : "Off";
    case "choice": {
      if (values.settings === undefined) return null;
      const current = value.read(values.settings);
      return (value.options as Readonly<Record<string, string>>)[current] ?? current;
    }
    case "state":
      return stateWords(value.state, values);
  }
}

function stateWords(state: GuideState, values: GuideValues): string | null {
  switch (state) {
    case "linkedComputers": {
      const computers = values.linkedComputers;
      if (computers === undefined) return null;
      if (computers.length === 0) return `${values.computerName} has no linked computers.`;
      return computers
        .map((computer) => {
          const here = computer.theirAgentsHere
            ? `its agents on ${values.computerName}: ${accessWords(computer.theirAgentsHere)}`
            : `its agents on ${values.computerName}: not linked this way`;
          const there = computer.ourAgentsThere
            ? `${values.computerName}'s agents on it: ${accessWords(computer.ourAgentsThere)}${computer.ourAgentsThere.fresh ? "" : " (as last seen)"}`
            : `${values.computerName}'s agents on it: unknown (set on ${computer.name})`;
          return `${computer.name} (${computer.reachable ? "reachable" : "offline"}): ${here}; ${there}.`;
        })
        .join(" ");
    }
    case "providers": {
      const providers = values.providers;
      if (providers === undefined) return null;
      return providers
        .map(
          (provider) =>
            `${provider.name}: ${provider.enabled ? (provider.signedIn === false ? "on, not signed in" : "on") : "off"}`,
        )
        .join("; ");
    }
    case "outsideAgents": {
      const agents = values.outsideAgents;
      if (agents === undefined) return null;
      return agents.length === 0 ? "None." : agents.map((agent) => agent.name).join(", ");
    }
    case "scheduledTasks": {
      const tasks = values.scheduledTasks;
      if (tasks === undefined) return null;
      return `${tasks.active} active, ${tasks.paused} paused.`;
    }
  }
}

/** One place, as a line of the answer: where it is (linked), what it does, its value. */
function placeLine(place: AppPlace, values: GuideValues): string {
  const scope = "scope" in place ? place.scope : "computer";
  const facts = [
    "appliesWhen" in place && place.appliesWhen === "desktop" ? "Desktop app only." : null,
    scope === "device"
      ? "Set on each device; you can't see its value."
      : scope === "desktop"
        ? "Set in each computer's desktop app; you can't see its value."
        : (() => {
            const now = valueWords(place, values);
            return now === null ? null : `Now on ${values.computerName}: ${now}`;
          })(),
  ].filter((fact): fact is string => fact !== null);
  return `- ${placeMarkdownLink(place.id)}: ${place.about}${facts.length > 0 ? ` ${facts.join(" ")}` : ""}`;
}

const expandPlaces = (body: string) =>
  body.replace(/\{place:([a-zA-Z0-9.]+)\}/gu, (_match, id: string) =>
    APP_PLACES.some((place) => place.id === id) ? placeMarkdownLink(id as PlaceId) : id,
  );

const LINK_NOTE =
  "Link places in your reply with the markdown links above: in Threadlines each opens the place and highlights it.";

const topicIndex = () =>
  GUIDE_TOPICS.map((topic) => `- \`${topic.id}\`: ${topic.title}`).join("\n");

/** The answer, in markdown. */
export function renderGuide(plan: GuidePlan, values: GuideValues): string {
  switch (plan.kind) {
    case "index":
      return [
        `Threadlines, on ${values.computerName}. Ask with \`query\` (plain words) or read a topic with \`topic\`.`,
        "**Pages**",
        APP_PLACES.filter((place) => place.kind === "page")
          .map((place) => `- ${placeMarkdownLink(place.id)}: ${place.about}`)
          .join("\n"),
        "**Topics**",
        topicIndex(),
        LINK_NOTE,
      ].join("\n\n");
    case "topic": {
      const places = topicPlaces(plan.topic).filter((place) => valueWords(place, values) !== null);
      return [
        `## ${plan.topic.title}`,
        expandPlaces(plan.topic.body),
        ...(places.length > 0
          ? [
              `**Now on ${values.computerName}**`,
              places.map((place) => placeLine(place, values)).join("\n"),
            ]
          : []),
        LINK_NOTE,
      ].join("\n\n");
    }
    case "unknownTopic":
      return `No topic \`${plan.topic}\`. Topics:\n\n${topicIndex()}`;
    case "noMatch":
      return `Nothing in the guide matches "${plan.query}". Try other words, or call app_guide with no arguments for the pages and topics.`;
    case "matches": {
      const [first, ...more] = plan.topics;
      return [
        ...(plan.places.length > 0
          ? ["**Places**", plan.places.map((place) => placeLine(place, values)).join("\n")]
          : []),
        ...(first !== undefined ? [`## ${first.title}`, expandPlaces(first.body)] : []),
        ...(more.length > 0
          ? [`More: ${more.map((topic) => `topic \`${topic.id}\` (${topic.title})`).join(", ")}.`]
          : []),
        LINK_NOTE,
      ].join("\n\n");
    }
  }
}
