import {
  RELAY_TOKEN_PROTOCOL_PREFIX,
  RELAY_WEBSOCKET_PROTOCOL,
} from "@threadlines/contracts/relay";

export function relayWebSocketProtocols(token: string): readonly [string, string] {
  return [RELAY_WEBSOCKET_PROTOCOL, `${RELAY_TOKEN_PROTOCOL_PREFIX}${token}`];
}
