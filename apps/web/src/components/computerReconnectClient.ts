/**
 * The calls the computer connection notices make, in a module of their own so
 * a test can stand in for them without mocking the whole runtime (which the
 * notice stack itself imports).
 */
export { getSavedEnvironmentRecord, reconnectSavedEnvironment } from "../environments/runtime";
