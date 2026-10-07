import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolStatus } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
// Agentia dependency output for a large change set can run to several megabytes.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// The line in an npm .cmd shim that runs the package's script:
//   "%_prog%"  "%dp0%\node_modules\@copado\agentia-cli\bin\run.js" %*
const NPM_SHIM_SCRIPT = /"%(?:~dp0|dp0%)\\([^"]+?)"\s+%\*/;

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Directory to run the program in. Defaults to the current directory. */
  cwd?: string;
  /** How long to wait before killing the program. Defaults to 15 seconds. */
  timeoutMs?: number;
}

/** The extra fields Node attaches to errors from execFile. */
type ExecFileFailure = Error & {
  code?: string | number | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

/** A program that couldn't be run or exited non-zero. Keeps its output so callers can inspect it. */
export class CommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, failure: ExecFileFailure) {
    super(message, { cause: failure });
    this.name = "CommandError";
    this.stdout = failure.stdout ?? "";
    this.stderr = failure.stderr ?? "";
  }
}

/**
 * Runs a program with execFile (never through a shell) and resolves with its output.
 * Rejects with a CommandError if the program is missing, times out, or exits non-zero.
 */
export async function runCommand(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execOptions = {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  } as const;
  try {
    return await execFileWithNpmShimFallback(file, args, execOptions);
  } catch (error) {
    const failure = error as ExecFileFailure;
    throw new CommandError(describeFailure(file, args, failure, timeoutMs), failure);
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

type ExecOptions = Parameters<typeof execFileAsync>[2] & { encoding: "utf8" };

/**
 * On Windows, npm installs CLIs such as agentia as .cmd shims, and execFile can't launch .cmd files
 * without a shell. If `file` isn't found, look for its npm shim and run the Node script it wraps directly.
 */
async function execFileWithNpmShimFallback(
  file: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<CommandOutput> {
  try {
    return await execFileAsync(file, args, options);
  } catch (error) {
    const notFound = (error as ExecFileFailure).code === "ENOENT";
    const script = notFound && process.platform === "win32" ? findNpmShimScript(file) : undefined;
    if (script === undefined) throw error;
    return await execFileAsync(process.execPath, [script, ...args], options);
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

function describeFailure(file: string, args: readonly string[], error: ExecFileFailure, timeoutMs: number): string {
  const command = [file, ...args].join(" ");
  if (error.code === "ENOENT") return `"${file}" was not found. Is it installed and on your PATH?`;
  if (error.killed) return `"${command}" did not finish within ${timeoutMs / 1000}s.`;
  if (typeof error.code === "number") {
    const reason = firstLine(error.stderr ?? "");
    return `"${command}" exited with code ${error.code}${reason ? `: ${reason}` : "."}`;
  }
  return firstLine(error.message);
}

/** The first line of output that isn't a CLI notice such as oclif's "» Warning: update available". */
function firstLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => line !== "" && !line.startsWith("»")) ?? "";
}
