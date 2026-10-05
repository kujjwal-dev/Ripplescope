#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { checkAgentia } from "./agentia.js";
import { checkGit } from "./git.js";
import { printEnvironmentCheck } from "./report.js";

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

await program.parseAsync();
