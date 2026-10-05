# RippleScope

A TypeScript CLI that will work with Copado Agentia Headless to compare a Copado User Story's intent against the actual blast radius of its Salesforce changes.

> **Status:** scaffold only. The `debug` environment check works; Copado, Salesforce, Agentia analysis, and dependency analysis are not implemented yet.

## Requirements

- Node.js 22.12 or later
- Git on your `PATH`
- The Copado Agentia Headless CLI (`agentia`) on your `PATH`

## Setup

```sh
npm install
```

## Usage

```sh
npm run dev -- debug    # run from source (tsx, no build step)
npm run build           # compile src/ to dist/
npm start -- debug      # run the compiled CLI
```

`debug` checks that Node, Git (`git --version`) and Agentia (`agentia --version`) can be run, prints the version of each or a clear error, and exits with code 1 if any check fails.

To use the `ripplescope` command directly, run `npm run build` and then `npm link`.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev -- <command>` | Run the CLI from `src/` with tsx |
| `npm run build` | Compile `src/` to `dist/` with `tsc` |
| `npm start -- <command>` | Run the compiled CLI from `dist/` |
| `npm run typecheck` | Type-check without emitting files |

## Project layout

```
src/
  cli.ts         CLI entry point and commands (commander)
  exec.ts        Runs external programs with execFile, never through a shell
  git.ts         Git integration (currently: version check)
  agentia.ts     Agentia Headless integration (currently: version check)
  story.ts       Copado User Story intent (not implemented)
  analyzer.ts    Blast-radius analysis (not implemented)
  scorer.ts      Intent vs. blast-radius scoring (not implemented)
  report.ts      Terminal output
  types.ts       Shared types
prompts/
  impact-analysis.txt   Prompt for Agentia impact analysis (placeholder)
fixtures/        Sample inputs for local testing
```

External programs are always started with `child_process.execFile` and an argument list, never a shell command string. On Windows, npm installs CLIs such as `agentia` as `.cmd` shims, which `execFile` can't launch without a shell, so RippleScope reads the shim and runs the Node script it points to directly.
