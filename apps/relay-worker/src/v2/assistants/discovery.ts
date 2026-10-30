import { ASSISTANT_MCP_PATH, AssistantScope } from "@threadlines/contracts/relayAssistants";

/** Every scope an assistant may ask for, in a fixed order. */
export const ASSISTANT_SCOPES: ReadonlyArray<AssistantScope> = AssistantScope.literals;

/**
 * RFC 9728 protected resource metadata for `<origin>/mcp`, served at
 * `/.well-known/oauth-protected-resource/mcp` (and without the path, for
 * clients that look there first). Static: the relay is the authorization
 * server's front, the computer behind it mints every credential.
 */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${ASSISTANT_MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: ASSISTANT_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Threadlines",
  };
}

/** RFC 8414 authorization server metadata: public clients, the code flow with S256 only. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: ASSISTANT_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
