# RippleScope

**RippleScope — Before You Push, Know What Ripples.**

RippleScope is an Agentia-powered pre-release blast-radius analyzer for Salesforce. Point it at a Salesforce
source-format repository on a Copado feature branch, and it tells you what your change will touch, how risky it
is, and what to check before you push — built for the Agentia Headless Virtual Hackathon 2026.

```
Developer changes Salesforce metadata/code
        ↓
RippleScope inspects local Git changes
        ↓
Copado Agentia Headless returns real org dependency intelligence
        ↓
RippleScope adds NEW local dependencies the deployed org doesn't have yet
        ↓
Merged graph → risk score + blast radius + recommended checks
```

## Agentia vs. RippleScope

- **Agentia** knows the *deployed org*: which existing components consume or depend on the components you changed.
- **RippleScope** combines that with a *prospective* layer: it reads your local, not-yet-deployed source and finds
  relationships your change **introduces**, which the org — and therefore Agentia — can't know about yet.

Example: a story changes `CopadoService`, `CopadoServiceTest` and adds `Account.Copado_Status__c`. The new
`CopadoService` code does `return accountRecord.Copado_Status__c;`. Agentia reports the layout that uses the
field and the test that uses the class, but not `CopadoService → Account.Copado_Status__c`, because that reference
hasn't been deployed. RippleScope adds it, marks it **NEW**, and recommends shipping the field and the class
together. That merged *future* blast radius is the product.

## Requirements

- Node.js 22.12 or later
- Git on your `PATH`
- The Copado Agentia Headless CLI (`agentia`) on your `PATH`
- `AGENTIA_CICD_API_KEY` set in your environment (RippleScope never reads, prints or stores its value; the
  `agentia` process inherits it)

```sh
npm install
```

## Usage

```sh
npm run dev -- debug                                               # check Node, Git and Agentia
npm run dev -- scan ../Copado-copadoorg43SFP                       # story inferred from feature/US-... branch
npm run dev -- scan ../Copado-copadoorg43SFP --story US-0000024    # explicit story
npm run dev -- scan ../Copado-copadoorg43SFP --json                # machine-readable JSON only
```

| Option | Meaning |
| --- | --- |
| `--story <id>` | Copado user story. Defaults to the one in a `feature/US-0000024` branch name. |
| `--base-ref <ref>` | Git ref to compare against. Defaults to `origin/<story base branch>`. |
| `--json` | Print only JSON: story, repo, changed components, Agentia and local dependencies, merged edges, risk, recommendations, warnings. |

`npm run build` compiles to `dist/`; `npm start -- scan <repo>` runs the compiled CLI.

### What `scan` does

1. Validates the repo, reads the branch and resolves the user story.
2. Runs `agentia cicd work get <story> --json` for the pipeline, source org, source credential and base branch — no
   IDs are hardcoded.
3. Collects changed files relative to `origin/<baseBranch>`: committed on the branch, staged, unstaged and untracked.
4. Maps source-format paths to components (ApexClass, ApexTrigger, CustomField, ValidationRule, CustomObject,
   Layout, Flow, PermissionSet, LWC, Aura).
5. Runs `agentia cicd metadata dependency list --from-changes --retrieve-mode all ...` in the Salesforce repo.
6. Scans changed Apex for references to other changed components (word-boundary matching, ignoring comments and
   strings) to find prospective dependencies.
7. Merges both graphs, recording each edge's provenance: `agentia`, `local` or both.
8. Scores risk and generates recommendations.

**Coverage note:** Agentia's `--from-changes` only analyses committed branch changes and staged files. If you have
unstaged or untracked Salesforce changes, RippleScope still analyses them locally but warns that Agentia's
dependency coverage may be incomplete until you stage or commit them.

RippleScope is read-only: it never stages, commits, pushes, deploys or runs Agentia `work push/submit/done`.

### Risk score

Deterministic and explainable — every point appears in the report's *Why* section:

| Points | Rule |
| --- | --- |
| +10 | per changed Salesforce component |
| +10 | per existing org component (from Agentia) that consumes the change and isn't part of it |
| +10 | per new local-only dependency from production (non-test) code |
| +10 | if production Apex changed |
| +15 | if changed production Apex has no test class linked in the graph |
| +5 | if a page layout is in the blast radius |

Capped at 100. `0–24` LOW, `25–69` MEDIUM, `70–100` HIGH.

## Project layout

```
src/
  cli.ts        Commander wiring for `debug` and `scan`
  scan.ts       Scan orchestration
  exec.ts       Runs programs with execFile (never a shell), with cwd and timeout
  git.ts        Repo validation, branch, changed files (read-only)
  agentia.ts    Agentia `work get` and `dependency list`, parsed with Zod
  story.ts      Story inference from the branch and loading from Copado
  analyzer.ts   Path → component mapping, local reference finder, graph merge
  score.ts      Risk score and recommendations
  report.ts     Terminal output
  types.ts      Shared types
```

External programs are always started with `child_process.execFile` and an argument list. On Windows, npm installs
CLIs such as `agentia` as `.cmd` shims, which `execFile` can't launch without a shell, so RippleScope reads the shim
and runs the Node script it points to directly.
