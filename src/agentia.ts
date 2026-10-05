import { checkVersion } from "./exec.js";
import type { ToolStatus } from "./types.js";

/** Checks that the Copado Agentia Headless CLI is installed by running `agentia --version`. */
export function checkAgentia(): Promise<ToolStatus> {
  return checkVersion("agentia");
}
