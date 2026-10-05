import { checkVersion } from "./exec.js";
import type { ToolStatus } from "./types.js";

/** Checks that Git is installed by running `git --version`. */
export function checkGit(): Promise<ToolStatus> {
  return checkVersion("git");
}
