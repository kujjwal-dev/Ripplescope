#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { checkAgentia } from "./agentia.js";
import { checkGit } from "./git.js";
import { formatScanReport, printEnvironmentCheck } from "./report.js";
import { scan } from "./scan.js";

// Resolves to the project root from both src/ (dev) and dist/ (built).
const { version, description } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  description: string;
};

const program = new Command().name("ripplescope").description(description).version(version);

program
  .command("debug")
  .description("Check that Node, Git and the Agentia CLI are available")
  .action(async () => {
    const allOk = await printEnvironmentCheck([
      { label: "Node", status: { ok: true, version: process.version } },
      { label: "Git", status: checkGit() },
      { label: "Agentia", status: checkAgentia() },
    ]);
    if (!allOk) process.exitCode = 1;
  });

program
  .command("scan")
  .description("Show the blast radius of a Salesforce repo's changes: Agentia org dependencies plus new local ones")
  .argument("<repo>", "path to the Salesforce source-format Git repository")
  .option("--story <id>", "Copado user story (default: inferred from a feature/US-... branch)")
  .option("--base-ref <ref>", "Git ref to compare against (default: origin/<story base branch>)")
  .option("--json", "print machine-readable JSON only")
  .action(async (repo: string, options: { story?: string; baseRef?: string; json?: boolean }) => {
    const json = options.json === true;
    // Progress goes to stderr, so stdout carries only the report or the JSON.
    const onProgress = !json && process.stderr.isTTY ? (message: string) => process.stderr.write(`${message}\n`) : undefined;
    try {
      const { result, testClasses } = await scan(repo, { story: options.story, baseRef: options.baseRef, onProgress });
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatScanReport(result, testClasses));
    } catch (error) {
      const message = (error as Error).message;
      if (json) process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
      else process.stderr.write(`RippleScope: ${message}\n`);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
