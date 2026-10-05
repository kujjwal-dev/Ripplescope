import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import type { ToolStatus } from "./types.js";

export interface EnvironmentCheck {
  label: string;
  /** A promise while the check is still running. */
  status: ToolStatus | Promise<ToolStatus>;
}

const LABEL_WIDTH = 11;
const STATUS_WIDTH = 7;

/**
 * Prints the `debug` environment table and resolves to true if every check passed.
 * In a terminal, pending checks show "checking..." until all of them finish and the rows are redrawn
 * with the results; when output is piped, only the final rows are printed.
 */
export async function printEnvironmentCheck(checks: readonly EnvironmentCheck[]): Promise<boolean> {
  const out = process.stdout;
  out.write("RippleScope\nEnvironment Check\n\n");

  const live = out.isTTY;
  if (live) {
    for (const { label, status } of checks) {
      out.write(formatRow(label, status instanceof Promise ? "checking..." : formatStatus(status)));
    }
  }

  const results = await Promise.all(checks.map(async ({ label, status }) => ({ label, status: await status })));

  if (live) {
    // Move back up over the rows printed above and replace them.
    cursorTo(out, 0);
    moveCursor(out, 0, -checks.length);
    clearScreenDown(out);
  }
  for (const { label, status } of results) {
    out.write(formatRow(label, formatStatus(status)));
  }

  return results.every(({ status }) => status.ok);
}

function formatStatus(status: ToolStatus): string {
  return status.ok
    ? "OK".padEnd(STATUS_WIDTH) + status.version
    : "ERROR".padEnd(STATUS_WIDTH) + status.error;
}

function formatRow(label: string, text: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${text}\n`;
}
