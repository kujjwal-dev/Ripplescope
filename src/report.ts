import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { componentKey, isTestClass } from "./analyzer.js";
import type { ScanResult, ToolStatus } from "./types.js";

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

// --- scan report ---------------------------------------------------------------------------------

// ANSI styling only when writing to a terminal that wants colour, so piped output stays plain text.
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const style = (code: string) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = style("1");
const dim = style("2");
const red = style("31");
const green = style("32");
const yellow = style("33");
const cyan = style("36");
const magenta = style("35");

const TYPE_WIDTH = 14;

/** Renders a scan as a terminal report. */
export function formatScanReport(result: ScanResult, testClasses: ReadonlySet<string> = new Set()): string {
  const lines: string[] = [];
  const section = (title: string) => lines.push("", bold(title));
  const changedKeys = new Set(result.changedComponents.map(componentKey));

  lines.push(`${cyan("🌊 RippleScope")}`, dim("Before You Push, Know What Ripples."));

  const { story, repo } = result;
  section("Story");
  lines.push(`  ${bold(story.name)}${story.title ? ` — ${story.title}` : ""}`);
  if (story.sourceEnvironmentName) lines.push(`  Environment: ${story.sourceEnvironmentName}`);
  lines.push(dim(`  Branch: ${repo.branch || "(detached HEAD)"} · compared with ${repo.baseRef}`));

  section("Changed components");
  if (result.changedComponents.length === 0) lines.push(dim("  No Salesforce metadata changes found."));
  const nameWidth = Math.max(0, ...result.changedComponents.map((c) => c.name.length)) + 2;
  for (const component of result.changedComponents) {
    lines.push(`  • ${component.type.padEnd(TYPE_WIDTH)}${component.name.padEnd(nameWidth)}${dim(component.states.join(", "))}`);
  }

  section("Agentia org ripples");
  if (!result.agentia.ok) lines.push(yellow("  Unavailable — see warnings below."));
  else if (result.agentiaDependencies.every((n) => n.consumers.length === 0 && n.dependencies.length === 0)) {
    lines.push(dim("  Agentia found no existing dependencies for these components."));
  }
  for (const node of result.agentiaDependencies) {
    if (node.consumers.length === 0 && node.dependencies.length === 0) continue;
    lines.push(`  ${node.component.name}`);
    for (const consumer of node.consumers) lines.push(`    ${green("↑")} ${consumer.name}  ${dim(consumer.type)}`);
    for (const dependency of node.dependencies) lines.push(`    ${dim("↓")} ${dependency.name}  ${dim(dependency.type)}`);
  }
  if (result.agentia.ok && result.agentiaDependencies.length > 0) lines.push(dim("  ↑ used by   ↓ depends on"));

  section("Prospective local ripples");
  if (result.localDependencies.length === 0) lines.push(dim("  No new references found in the local source."));
  for (const local of result.mergedEdges.filter((edge) => edge.provenance.includes("local"))) {
    // Display only: provenance in the JSON is unchanged. Test classes don't ship behaviour, so their new
    // references are shown apart from production ones.
    const tag = local.provenance.includes("agentia")
      ? dim("ORG ")
      : isTestClass(local.from, testClasses)
        ? cyan("TEST")
        : magenta(bold("NEW "));
    lines.push(`  ${tag}  ${local.from.name} → ${local.to.name}`);
    if (local.evidence) lines.push(dim(`        ${local.evidence}`));
  }
  if (result.localDependencies.length > 0) {
    lines.push(dim("  NEW  = production code introduces it; not in the deployed org yet"));
    lines.push(dim("  TEST = a test class introduces it; not in the deployed org yet"));
    lines.push(dim("  ORG  = also found by local analysis; already known to Agentia"));
  }

  section(`Blast radius (${result.blastRadius.length})`);
  for (const component of result.blastRadius) {
    const changed = changedKeys.has(componentKey(component));
    lines.push(`  • ${component.type.padEnd(TYPE_WIDTH)}${component.name}${changed ? dim("  changed") : ""}`);
  }

  const { risk } = result;
  const levelColor = risk.level === "HIGH" ? red : risk.level === "MEDIUM" ? yellow : green;
  section("Risk");
  lines.push(`  ${levelColor(bold(`${risk.level} · ${risk.score}/100`))}`);

  section("Why");
  for (const { points, reason } of risk.reasons) lines.push(`  ${dim(`+${points}`.padStart(4))}  ${reason}`);

  section("Recommended checks");
  for (const { message } of result.recommendations) lines.push(`  ${green("✓")} ${message}`);

  if (result.warnings.length > 0) {
    section("Warnings");
    for (const warning of result.warnings) lines.push(`  ${yellow("!")} ${warning}`);
  }

  return `${lines.join("\n")}\n`;
}
