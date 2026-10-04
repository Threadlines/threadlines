// The relay worker has no Node types; tests only need this slice of `node:sqlite`.
declare module "node:sqlite" {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;
  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): { all(...params: SQLInputValue[]): unknown[] };
  }
}
