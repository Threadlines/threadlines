/**
 * Which room tools a runtime may use (docs/design/rooms-slice-2.md, Part B).
 *
 * One table, read by everything that has to agree on it: the credential
 * registry (what a token may call), the room endpoint (what a handler
 * refuses), Claude's `allowedTools` and deny-by-default hook, and Codex's
 * `enabled_tools`. A side runtime is listed the tools its kind allows and is
 * also refused the others at the endpoint, so a runtime that ignores its list
 * still cannot reach them.
 */

/** The room endpoint's name, as each provider namespaces its tools. */
export const ROOM_MCP_SERVER_NAME = "threadlines_room";

export const ROOM_TOOL_NAMES = [
  "room_agents",
  "room_ask",
  "room_review",
  "room_hand_off",
  "room_history",
  "room_diff",
  "room_available_agents",
  "room_invite",
] as const;
export type RoomToolName = (typeof ROOM_TOOL_NAMES)[number];

/** What kind of side runtime a credential belongs to. */
export type RoomSideKind = "ask" | "review";

/**
 * The room tools one runtime may use. A main runtime gets every tool (the
 * decider still decides who may make a request); an answerer reads the room
 * and the checkout; an independent reviewer reads only the checkout, never
 * the conversation.
 */
export function roomToolsFor(side: RoomSideKind | undefined): ReadonlyArray<RoomToolName> {
  switch (side) {
    case undefined:
      return ROOM_TOOL_NAMES;
    case "ask":
      return ["room_history", "room_diff"];
    case "review":
      return ["room_diff"];
  }
}

/** A room tool as Claude names it (`mcp__<server>__<tool>`). */
export const claudeRoomToolId = (tool: RoomToolName): string =>
  `mcp__${ROOM_MCP_SERVER_NAME}__${tool}`;

/** The side kind a provider runtime's lockdown asks for. */
export function roomSideKindOf(
  lockdown: "side-answer" | "side-review" | undefined,
): RoomSideKind | undefined {
  switch (lockdown) {
    case undefined:
      return undefined;
    case "side-answer":
      return "ask";
    case "side-review":
      return "review";
  }
}
