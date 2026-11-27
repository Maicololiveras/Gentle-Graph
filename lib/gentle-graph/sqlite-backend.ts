// Keep the relational store and the native binding off the JSON query path.
import {createRequire} from "node:module";
export const SQL_FILE_THRESHOLD=2000;
const require=createRequire(import.meta.url);
type Backend=typeof import("./store-sqlite.ts");
let loaded:Backend|undefined;
export function sqliteBackend():Backend {
  return loaded??=require("./store-sqlite.ts");
}
export function existingBackend(){return loaded;}
