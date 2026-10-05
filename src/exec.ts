import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolStatus } from "./types.js";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 15_000;
const OPTIONS = { encoding: "utf8", timeout: TIMEOUT_MS, windowsHide: true } as const;

// The line in an npm .cmd shim that runs the package's script:
//   "%_prog%"  "%dp0%\node_modules\@copado\agentia-cli\bin\run.js" %*
const NPM_SHIM_SCRIPT = /"%(?:~dp0|dp0%)\\([^"]+?)"\s+%\*/;

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

/** The extra fields Node attaches to errors from execFile. */
type ExecFileFailure = Error & {
  code?: string | number | null;
  killed?: boolean;
  stderr?: string;
};

/**
 * Runs a program with execFile (never through a shell) and resolves with its output.
 * Rejects with a readable message if the program is missing, times out, or exits non-zero.
 */
export async function runCommand(file: string, args: readonly string[]): Promise<CommandOutput> {
  try {
    return await execFileWithNpmShimFallback(file, args);
  } catch (error) {
    throw new Error(describeFailure(file, args, error as ExecFileFailure), { cause: error });
  }
}

/** Runs `<file> --version` and reports the first line it prints, or why it couldn't run. */
export async function checkVersion(file: string): Promise<ToolStatus> {
  try {
    const { stdout, stderr } = await runCommand(file, ["--version"]);
    return { ok: true, version: firstLine(stdout) || firstLine(stderr) || "(no version output)" };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * On Windows, npm installs CLIs such as agentia as .cmd shims, and execFile can't launch .cmd files
 * without a shell. If `file` isn't found, look for its npm shim and run the Node script it wraps directly.
 */
async function execFileWithNpmShimFallback(file: string, args: readonly string[]): Promise<CommandOutput> {
  try {
    return await execFileAsync(file, args, OPTIONS);
  } catch (error) {
    const notFound = (error as ExecFileFailure).code === "ENOENT";
    const script = notFound && process.platform === "win32" ? findNpmShimScript(file) : undefined;
    if (script === undefined) throw error;
    return await execFileAsync(process.execPath, [script, ...args], OPTIONS);
  }
}

/** Returns the Node script behind the first `<file>.cmd` on PATH, if that file is an npm shim. */
function findNpmShimScript(file: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    let shim: string;
    try {
      shim = readFileSync(path.join(dir, `${file}.cmd`), "utf8");
    } catch {
      continue;
    }
    // npm only writes node.exe into the shim when the script is meant to run under Node.
    const script = NPM_SHIM_SCRIPT.exec(shim)?.[1];
    return script !== undefined && shim.includes("node.exe") ? path.join(dir, script) : undefined;
  }
  return undefined;
}

function describeFailure(file: string, args: readonly string[], error: ExecFileFailure): string {
  const command = [file, ...args].join(" ");
  if (error.code === "ENOENT") return `"${file}" was not found. Is it installed and on your PATH?`;
  if (error.killed) return `"${command}" did not finish within ${TIMEOUT_MS / 1000}s.`;
  if (typeof error.code === "number") {
    const reason = firstLine(error.stderr ?? "");
    return `"${command}" exited with code ${error.code}${reason ? `: ${reason}` : "."}`;
  }
  return firstLine(error.message);
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}
