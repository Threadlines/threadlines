export {
  getPrimaryKnownEnvironment,
  readPrimaryEnvironmentDescriptor,
  resetPrimaryEnvironmentDescriptorForTests,
  resolveInitialPrimaryEnvironmentDescriptor,
  subscribePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
  writePrimaryEnvironmentDescriptor,
  __resetPrimaryEnvironmentBootstrapForTests,
  __resetPrimaryEnvironmentDescriptorBootstrapForTests,
} from "./context";

export {
  resolveInitialPrimaryEnvironmentDescriptor as ensurePrimaryEnvironmentReady,
  writePrimaryEnvironmentDescriptor as updatePrimaryEnvironmentDescriptor,
} from "./context";

export {
  createServerPairingCredential,
  ensureDesktopSession,
  fetchSessionState,
  hasDesktopSessionCredential,
  listServerClientSessions,
  listServerPairingLinks,
  peekPairingTokenFromUrl,
  readSessionExpiryMs,
  renameServerClientSession,
  resolveInitialServerAuthGateState,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
  takePairingTokenFromUrl,
  type DesktopSessionOutcome,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
  __resetServerAuthBootstrapForTests,
} from "./auth";

export {
  isLoopbackHostname,
  isPrimaryEnvironmentOnThisComputer,
  resolvePrimaryEnvironmentHttpUrl,
} from "./target";

export { watchDesktopSessionExpiry } from "./desktopSession";

export {
  isPrimaryAccessRemoved,
  probePrimaryAccess,
  setPrimaryAccessRemoved,
  usePrimaryAccessRemoved,
  type PrimaryAccessProbeOutcome,
} from "./accessRemoval";
