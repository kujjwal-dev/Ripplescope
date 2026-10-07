import { stat } from "node:fs/promises";
import path from "node:path";
import { checkVersion, runCommand } from "./exec.js";
import type { ChangedFile, ChangeState, ToolStatus } from "./types.js";

// Every command here only reads repository state. RippleScope never stages, commits, fetches or resets.

/** Checks that Git is installed by running `git --version`. */
export function checkGit(): Promise<ToolStatus> {
  return checkVersion("git");
}

/** Resolves `dir` to the root of the Git repository that contains it, or throws a readable error. */
export async function resolveRepoRoot(dir: string): Promise<string> {
  const absolute = path.resolve(dir);
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${absolute} is not a directory.`);
  try {
    const { stdout } = await git(absolute, ["rev-parse", "--show-toplevel"]);
    return path.resolve(stdout.trim());
  } catch {
    throw new Error(`${absolute} is not inside a Git repository.`);
  }
}

/** The checked-out branch name, or "" when HEAD is detached. */
export async function currentBranch(repo: string): Promise<string> {
  const { stdout } = await git(repo, ["branch", "--show-current"]);
  return stdout.trim();
}

/** Whether `ref` names a commit in the local repository. */
export async function refExists(repo: string, ref: string): Promise<boolean> {
  assertSafeRef(ref);
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists every file that differs from `baseRef`, recording whether each change is committed on the branch,
 * staged, unstaged or untracked. Pass `baseRef: undefined` to skip committed changes (e.g. the ref is missing).
 */
export async function listChangedFiles(repo: string, baseRef: string | undefined): Promise<ChangedFile[]> {
  if (baseRef !== undefined) assertSafeRef(baseRef);
  const [committed, staged, unstaged, untracked] = await Promise.all([
    baseRef === undefined ? [] : gitPaths(repo, ["diff", "--name-only", "-z", `${baseRef}...HEAD`, "--"]),
    gitPaths(repo, ["diff", "--cached", "--name-only", "-z", "--"]),
    gitPaths(repo, ["diff", "--name-only", "-z", "--"]),
    gitPaths(repo, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);

  const byPath = new Map<string, Set<ChangeState>>();
  const add = (paths: string[], state: ChangeState) => {
    for (const file of paths) {
      const states = byPath.get(file) ?? new Set<ChangeState>();
      states.add(state);
      byPath.set(file, states);
    }
  };
  add(committed, "committed");
  add(staged, "staged");
  add(unstaged, "unstaged");
  add(untracked, "untracked");

  return [...byPath]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, states]) => ({ path: file, states: [...states] }));
}

/** Runs a Git command that prints NUL-separated paths relative to the repository root. */
async function gitPaths(repo: string, args: string[]): Promise<string[]> {
  const { stdout } = await git(repo, args);
  return stdout.split("\0").filter((file) => file !== "");
}

function git(repo: string, args: string[]) {
  // core.quotepath=off keeps non-ASCII paths readable in commands that don't take -z.
  return runCommand("git", ["-c", "core.quotepath=off", ...args], { cwd: repo });
}

/** Refuses refs that Git could mistake for an option. Arguments never pass through a shell. */
function assertSafeRef(ref: string): void {
  if (ref === "" || ref.startsWith("-") || /[\s\0]/.test(ref)) {
    throw new Error(`"${ref}" is not a valid Git ref.`);
  }
}
