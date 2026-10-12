# RippleScope

**Before You Push, Know What Ripples.**

RippleScope is a Salesforce pre-release change-impact analyzer powered by **Copado Agentia Headless**. It merges
the real dependency graph of your *deployed* org (from Agentia) with the *new* dependencies your local, undeployed
changes introduce. Then it tells you how risky the change is and what to check before you push.

Built for the **Agentia Headless Virtual Hackathon 2026**.

---

## The Problem

Salesforce changes rarely stay contained. A new field appears on a page layout, gets read by Apex and is covered
(or not) by a test. Before every release, someone has to answer the same questions: *What does this change
touch? What could break? Which tests should run? What has to ship together?*

Org-side dependency analysis can answer that for metadata that's already deployed. The relationships that cause
the most trouble, though, are often the ones the change itself creates. If new Apex reads a new field, that
reference doesn't exist in the org yet, so nothing that looks only at the org can see it. Problems like this
usually show up at deploy time, or in production.

## The Solution

RippleScope runs on the developer's branch, before the push. It merges two views of the change:

1. **Agentia deployed-org dependencies**: what already depends on the changed components in the real org.
2. **Local prospective dependencies**: what the developer's uncommitted or unpushed Apex *will* depend on once
   it ships.

From the merged graph it produces:

- the changed Salesforce components
- the blast radius
- prospective **NEW** dependencies, each with the file and line where it was found
- a deterministic risk score, with the reason for every point
- recommended Apex tests to run
- layouts and components to verify
- metadata that should be released together
- structured JSON output

## How RippleScope Works

```
       Salesforce repo  (Copado Source Format, feature/US-XXXXXXX branch)
                                     |
                                     |  committed, staged, unstaged and
                                     |  untracked changes vs. the base branch
                                     v
                      +-----------------------------+
                      |       RippleScope CLI       |
                      |  changed files -> changed   |
                      |  Salesforce components      |
                      +-----------------------------+
                           |                   |
     agentia cicd metadata |                   | read changed Apex
     dependency list       |                   | source on disk
                           v                   v
     +-----------------------------+   +-----------------------------+
     |  Copado Agentia Headless    |   |  Local prospective analysis |
     |  Deployed-org dependencies  |   |  NEW dependencies the org   |
     |                             |   |  doesn't have yet           |
     |  "what already ripples"     |   |  "what WILL ripple"         |
     +-----------------------------+   +-----------------------------+
                           |                   |
                           +---------+---------+
                                     v
                      +-----------------------------+
                      |   Merged dependency graph   |
                      |  provenance: agentia/local  |
                      +-----------------------------+
                                     |
                                     v
     Blast radius | Risk score + reasons | Recommended checks | JSON
```

What `scan` does, step by step:

1. **Resolve the story.** Infers the Copado user story from a `feature/US-…` branch (or takes `--story`) and loads
   its pipeline, source org, credential and base branch with `agentia cicd work get`. No IDs are hardcoded.
2. **Collect changes.** Finds committed, staged, unstaged and untracked files relative to `origin/<base branch>`.
3. **Map to components.** Converts source-format paths to Salesforce components (ApexClass, ApexTrigger,
   CustomField, ValidationRule, CustomObject, Layout, Flow, PermissionSet, LWC, Aura).
4. **Ask Agentia.** Runs `agentia cicd metadata dependency list --from-changes` to get what uses, and what is used
   by, the changed components in the deployed org.
5. **Analyze locally.** Scans changed Apex for references to the other changed components, ignoring comments and
   string literals, and records the file and line of each one.
6. **Merge.** Combines both graphs, and each edge keeps its provenance: `agentia`, `local` or both. An edge found
   *only* locally is a prospective **NEW** dependency.
7. **Score and recommend.** Applies fixed rules to produce the risk score, its reasons and the recommended checks.

Steps 4 and 5 run in parallel.

<details>
<summary><b>Source layout</b></summary>

```
src/
  cli.ts        Commander wiring for `debug` and `scan`
  scan.ts       Scan orchestration
  git.ts        Repo validation, branch, changed files (read-only)
  agentia.ts    Agentia `work get` and `dependency list`, validated with Zod
  story.ts      Story inference from the branch and loading from Copado
  analyzer.ts   Path → component mapping, local reference finder, graph merge
  score.ts      Risk score and recommendations
  report.ts     Terminal output
  exec.ts       Runs external programs with execFile (never a shell)
  types.ts      Shared types
```

</details>

## What Makes RippleScope Different

|                                       | Copado Agentia Headless              | RippleScope                                              |
| ------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| **Looks at**                          | The deployed Salesforce org          | The deployed org **plus** local, undeployed source       |
| **Answers**                           | What already depends on what         | What **will** depend on what after the push              |
| **New dependencies in undeployed code** | Not visible until they're deployed | Detected, marked **NEW**, with file and line evidence    |
| **Role in RippleScope**               | Supplies the real org graph          | Adds the prospective layer and turns the merged graph into risk and checks |

> **Agentia tells us what already ripples. RippleScope tells us what *will* ripple if we push the local change.**

RippleScope doesn't replace Agentia; it builds on it. Without Agentia there is no real org graph. Without
RippleScope's local analysis, the riskiest new relationships stay invisible until deployment.

## Demo Example

User story **US-0000024** changes three components in a Copado Source Format repository:

| Type        | Component                  |
| ----------- | -------------------------- |
| ApexClass   | `CopadoService`            |
| ApexClass   | `CopadoServiceTest`        |
| CustomField | `Account.Copado_Status__c` |

**Agentia, from the deployed org** (`A → B` means *A depends on B*):

```
CopadoServiceTest         →  CopadoService
Account-Account Layout    →  Account.Copado_Status__c
Account.Copado_Status__c  →  Account
```

**RippleScope, from the local, undeployed Apex:**

```apex
// force-app/main/default/classes/CopadoService.cls, line 12
return accountRecord.Copado_Status__c;
```

```
CopadoService  →  Account.Copado_Status__c     NEW
```

This is the main differentiator. The reference exists only on the developer's branch, so the org, and therefore
Agentia, can't report it yet. RippleScope adds it to the graph, marks it **NEW**, adds it to the risk score and
recommends releasing the field together with the class. If `CopadoService` were deployed without
`Account.Copado_Status__c`, the Apex wouldn't compile in the target org.

## Example Output

Abbreviated output of `npm run dev -- scan ../Copado-copadoorg43SFP` for the demo story:

```
🌊 RippleScope
Before You Push, Know What Ripples.

Changed components
  • ApexClass     CopadoService             committed
  • ApexClass     CopadoServiceTest         committed
  • CustomField   Account.Copado_Status__c  committed

Agentia org ripples
  CopadoService
    ↑ CopadoServiceTest  ApexClass
  Account.Copado_Status__c
    ↑ Account-Account Layout  Layout
    ↓ Account  CustomObject
  ↑ used by   ↓ depends on

Prospective local ripples
  NEW   CopadoService → Account.Copado_Status__c
        force-app/main/default/classes/CopadoService.cls:12  return accountRecord.Copado_Status__c;

Blast radius (5)
  • ApexClass     CopadoService  changed
  • ApexClass     CopadoServiceTest  changed
  • CustomField   Account.Copado_Status__c  changed
  • Layout        Account-Account Layout
  • CustomObject  Account

Risk
  MEDIUM · 65/100

Why
   +30  3 Salesforce components changed
   +10  1 existing org component consumes the change: Account-Account Layout
   +10  1 new dependency not yet in the deployed org: CopadoService → Account.Copado_Status__c
   +10  Production Apex changed: CopadoService
    +5  Page layout in the blast radius: Account-Account Layout

Recommended checks
  ✓ Run CopadoServiceTest (covers CopadoService)
  ✓ Verify layout Account-Account Layout — it uses Account.Copado_Status__c
  ✓ Verify new dependency CopadoService → Account.Copado_Status__c (not in the deployed org yet)
  ✓ Deploy Account.Copado_Status__c in the same release as CopadoService
  ✓ Include all changed metadata in the release: CopadoService, CopadoServiceTest, Account.Copado_Status__c
```

## Installation / Requirements

| Requirement                       | Notes                                                                       |
| --------------------------------- | --------------------------------------------------------------------------- |
| **Node.js 22.12+**                | Matches `engines` in `package.json`                                         |
| **Git**                           | On your `PATH`                                                              |
| **Copado Agentia Headless CLI**   | `agentia` on your `PATH`                                                    |
| **`AGENTIA_CICD_API_KEY`**        | Set in the environment; the `agentia` process inherits it                   |
| **Copado Source Format pipeline** | The Salesforce repo is a source-format repo connected to a Copado pipeline  |

```sh
git clone https://github.com/kujjwal-dev/Ripplescope.git
cd Ripplescope
npm install

# Set the key in your shell. Never commit it.
export AGENTIA_CICD_API_KEY="<your key>"          # bash / zsh
# $env:AGENTIA_CICD_API_KEY = "<your key>"        # PowerShell

npm run dev -- debug                               # check Node, Git and Agentia
```

### Security

- **RippleScope doesn't store API keys.** It never writes or prints `AGENTIA_CICD_API_KEY`. The `agentia` process
  inherits the key from the environment, and RippleScope redacts it from any Agentia error message it shows.
- **`scan` is analysis-only.** It never stages, commits, pushes, deploys or promotes Salesforce changes, and it
  only calls read-only Agentia commands (`work get`, `metadata dependency list`).
- **No shell execution.** External programs are started with `execFile` and an argument list.
- **`--json` output includes Copado record IDs** from the user story (pipeline, source org, credential). Review it
  before sharing it publicly.

## Usage

```sh
npm run dev -- debug                                               # environment check
npm run dev -- scan ../Copado-copadoorg43SFP                       # story inferred from feature/US-... branch
npm run dev -- scan ../Copado-copadoorg43SFP --story US-0000024    # explicit story
npm run dev -- scan ../Copado-copadoorg43SFP --json                # machine-readable JSON only
```

`../Copado-copadoorg43SFP` is the path to the Salesforce source-format repository you want to analyze.

| Option             | Meaning                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `--story <id>`     | Copado user story. Defaults to the one in a `feature/US-0000024` branch name. |
| `--base-ref <ref>` | Git ref to compare against. Defaults to `origin/<story base branch>`.          |
| `--json`           | Print only JSON to stdout. Progress messages go to stderr.                    |

`npm run build` compiles to `dist/`, and `npm start -- scan <repo>` runs the compiled CLI.

## Risk Scoring

The risk score is **deterministic and explainable**. It isn't an AI-generated guess: a small set of fixed rules
runs over the merged graph, the same input always produces the same score, and every point appears in the
report's *Why* section.

| Points | Rule                                                                              |
| -----: | --------------------------------------------------------------------------------- |
|    +10 | per changed Salesforce component                                                  |
|    +10 | per existing org component (from Agentia) that consumes the change and isn't part of it |
|    +10 | per NEW local-only dependency from production (non-test) code                     |
|    +10 | if production Apex changed                                                        |
|    +15 | if changed production Apex has no test class linked in the graph                 |
|     +5 | if a page layout is in the blast radius                                           |

The score is capped at 100: **0–24 LOW · 25–69 MEDIUM · 70–100 HIGH**.

In the demo, 30 + 10 + 10 + 10 + 5 = **65 → MEDIUM**. No +15 is added because Agentia links `CopadoServiceTest`
to `CopadoService`.

Recommendations come from the same graph. RippleScope only recommends tests that the graph links to the change.

## JSON / Extensibility

`--json` prints a single JSON document with everything the scan found:

| Field                                     | Contents                                                     |
| ----------------------------------------- | ------------------------------------------------------------ |
| `story`, `repo`                           | User story, branch, base ref, changed and ignored files      |
| `changedComponents`                       | Changed Salesforce components and their files                |
| `agentia`, `agentiaDependencies`          | Agentia status and the deployed-org dependency graph         |
| `localDependencies`                       | Prospective dependencies with file and line evidence         |
| `mergedEdges`                             | The merged graph; each edge has `provenance: ["agentia" \| "local"]` |
| `blastRadius`                             | Every component the change can reach                         |
| `risk`                                    | `score`, `level` and `reasons[]` (`points` and `reason`)     |
| `recommendations`                         | `kind` and `message`, e.g. `run-test`, `verify-new-dependency`, `deploy-together` |
| `warnings`                                | Coverage gaps, such as unstaged changes Agentia can't see    |

```jsonc
// abbreviated
{
  "localDependencies": [
    {
      "from": { "type": "ApexClass", "name": "CopadoService" },
      "to": { "type": "CustomField", "name": "Account.Copado_Status__c" },
      "provenance": ["local"],
      "evidence": "force-app/main/default/classes/CopadoService.cls:12  return accountRecord.Copado_Status__c;"
    }
  ],
  "risk": { "score": 65, "level": "MEDIUM", "reasons": [ /* … */ ] },
  "recommendations": [
    { "kind": "run-test", "message": "Run CopadoServiceTest (covers CopadoService)" },
    { "kind": "deploy-together", "message": "Deploy Account.Copado_Status__c in the same release as CopadoService" }
  ]
}
```

When piping, use `npm run -s dev -- scan … --json` or the built `node dist/cli.js scan … --json`, so npm's banner
doesn't come before the JSON. Failures print `{ "error": "…" }` and exit with code 1.

Because the output is structured and stable, it can later feed:

- **CI gates**, for example blocking a promotion when `risk.level` is `HIGH`
- **IDE extensions** that show ripples before commit
- **MCP tools**, so agents can request a blast-radius check
- **Pull-request reports** and review comments
- **Dashboards** that track release risk over time

These integrations aren't built yet; the JSON contract is the foundation for them. Local analysis is also
pluggable: the Apex finder implements a small `ReferenceFinder` interface, so a full parser or a Flow analyzer can
be added without changing the rest of the pipeline.

## Real Agentia / Copado Validation

The demo change was more than a test scan. It went through a real Copado pipeline using Agentia/Copado:

| Step         | Result        |
| ------------ | ------------- |
| SFDX Commit  | ✅ Successful |
| SFDX Promote | ✅ Successful |
| SFDX Deploy  | ✅ Successful |

**Environment movement: Dev1-SFP → INT-SFP**

RippleScope analyzed the change before it was pushed. The commit, promotion and deployment were done through
Copado; RippleScope itself never deploys or promotes.

## Current MVP Scope

**Implemented**

- `debug` and `scan` commands, with a colored terminal report and `--json` output
- Change detection for committed, staged, unstaged and untracked files
- Source-format mapping for ApexClass, ApexTrigger, CustomField, ValidationRule, CustomObject, Layout, Flow,
  PermissionSet, LWC and Aura
- Deployed-org dependencies from Agentia, with the user story's details loaded from Copado
- Local prospective analysis of changed Apex classes and triggers
- Graph merge with per-edge provenance, a deterministic risk score and recommendations

**Known limits**

- Local analysis uses token matching, not a full Apex parser. It finds references from changed Apex to the
  **other changed components** (Apex classes, custom objects and custom `__c` fields). References to unchanged org
  metadata are left to Agentia.
- Only Apex is scanned locally. Flows, LWC, Aura, layouts and permission sets are detected as changes and covered by
  Agentia's org graph, but they aren't scanned for new references.
- Agentia's `--from-changes` covers committed and staged changes. RippleScope still analyzes unstaged and untracked
  files locally, and warns that org coverage may be incomplete until they're staged.
- If Agentia fails for a reason other than authentication, the scan continues with local analysis only and shows a
  warning.

## Future Improvements

- **Deeper Apex parser**: replace token matching with a real parser and detect references to unchanged org
  metadata
- **Flow analysis**: find new field, object and Apex references in Flows
- **Permissions analysis**: check field-level security and permission set coverage for new fields
- **IDE integration**: show ripples in the editor before commit
- **PR comments**: post the report and risk score on pull requests
- **Agentia MCP integration**: make RippleScope's analysis available to Agentia-driven agent workflows over MCP
- **Visual dependency graph**: render the merged graph with NEW edges highlighted

## Hackathon

Built for the **Agentia Headless Virtual Hackathon 2026**.

**RippleScope: Before You Push, Know What Ripples.**
