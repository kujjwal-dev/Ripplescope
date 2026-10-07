import { AgentiaError, listDependencies } from "./agentia.js";
import {
  agentiaEdges,
  blastRadius,
  componentKey,
  findLocalDependencies,
  findLocalTestClasses,
  mergeEdges,
  toChangedComponents,
} from "./analyzer.js";
import { currentBranch, listChangedFiles, refExists, resolveRepoRoot } from "./git.js";
import { recommend, scoreRisk } from "./score.js";
import { loadStory, resolveStoryId } from "./story.js";
import type { AgentiaDependencies, ScanResult, Story } from "./types.js";

const EMPTY_AGENTIA: AgentiaDependencies = { nodes: [], notSupported: [] };

export interface ScanOptions {
  /** User story name; inferred from a feature/US-... branch when omitted. */
  story?: string;
  /** Overrides the base ref derived from the story's base branch. */
  baseRef?: string;
  /** Called with a short status line before each slow step. */
  onProgress?: (message: string) => void;
}

/**
 * Scans a Salesforce repository: loads its Copado user story, asks Agentia for the deployed org's
 * dependencies, adds the dependencies the local code introduces, and scores the merged blast radius.
 * Only reads the repository; never stages, commits, pushes or deploys.
 */
export interface ScanOutcome {
  /** Everything the scan found; this is what --json prints. */
  result: ScanResult;
  /** Changed Apex classes marked @IsTest in local source (keys from componentKey), for the terminal report. */
  testClasses: ReadonlySet<string>;
}

export async function scan(repoPath: string, options: ScanOptions = {}): Promise<ScanOutcome> {
  const progress = options.onProgress ?? (() => {});
  const warnings: string[] = [];

  const repo = await resolveRepoRoot(repoPath);
  const branch = await currentBranch(repo);
  const storyId = resolveStoryId(options.story, branch);

  progress(`Loading user story ${storyId} from Copado…`);
  const story = await loadStory(storyId, repo);

  let baseRef = options.baseRef;
  if (baseRef === undefined) {
    if (story.baseBranch === undefined) {
      warnings.push(`User story ${story.name} has no base branch; comparing against origin/main.`);
    }
    baseRef = `origin/${story.baseBranch ?? "main"}`;
  }
  const baseRefFound = await refExists(repo, baseRef);
  if (!baseRefFound) {
    warnings.push(
      `${baseRef} doesn't exist in this clone, so committed branch changes were skipped. Run "git fetch" to include them.`,
    );
  }

  const changedFiles = await listChangedFiles(repo, baseRefFound ? baseRef : undefined);
  const { components: changed, ignoredFiles } = toChangedComponents(changedFiles);

  const invisible = changed.filter((c) => c.states.some((s) => s === "unstaged" || s === "untracked"));
  if (invisible.length > 0) {
    warnings.push(
      `${invisible.map((c) => c.name).join(", ")} ha${invisible.length === 1 ? "s" : "ve"} unstaged or untracked changes. ` +
        "Agentia only analyses committed and staged changes, so its dependency coverage may be incomplete until you stage them.",
    );
  }

  // Agentia (remote, slow) and local analysis (disk) are independent.
  if (changed.length > 0) progress("Asking Agentia for org dependencies (this can take a minute)…");
  const [{ deps: agentia, error: agentiaError }, localDependencies, localTests] = await Promise.all([
    changed.length === 0 ? { deps: EMPTY_AGENTIA, error: undefined } : fetchAgentia(repo, baseRef, story),
    findLocalDependencies(repo, changed),
    findLocalTestClasses(repo, changed),
  ]);

  if (changed.length === 0) {
    warnings.push(`No Salesforce metadata changes found against ${baseRef}.`);
  }
  if (agentiaError !== undefined) {
    warnings.push(`${agentiaError} Showing local analysis only; org dependencies are missing.`);
  }
  if (agentia.notSupported.length > 0) {
    warnings.push(`Agentia couldn't analyse: ${agentia.notSupported.join(", ")}.`);
  }
  if (agentiaError === undefined && changed.length > 0) {
    const reported = new Set(agentia.nodes.map((node) => componentKey(node.component)));
    const missing = changed.filter((c) => !reported.has(componentKey(c)) && !invisible.includes(c));
    if (missing.length > 0) {
      warnings.push(`Agentia returned no dependency data for ${missing.map((c) => c.name).join(", ")}.`);
    }
  }

  const mergedEdges = mergeEdges(agentiaEdges(agentia.nodes), localDependencies);
  const radius = blastRadius(changed, mergedEdges);
  const scoreInput = { changed, agentiaNodes: agentia.nodes, edges: mergedEdges, blastRadius: radius, localTests };

  const result: ScanResult = {
    story,
    repo: { path: repo, branch, baseRef, changedFiles, ignoredFiles },
    changedComponents: changed,
    agentia: {
      ok: agentiaError === undefined,
      transactionId: agentia.transactionId,
      notSupported: agentia.notSupported,
      error: agentiaError,
    },
    agentiaDependencies: agentia.nodes,
    localDependencies,
    mergedEdges,
    blastRadius: radius,
    risk: scoreRisk(scoreInput),
    recommendations: recommend(scoreInput),
    warnings,
  };
  return { result, testClasses: localTests };
}

/**
 * Asks Agentia for the org dependencies of the branch's changes. Without credentials nothing else works either,
 * so auth failures are thrown; any other Agentia failure is returned so the local analysis can still be shown.
 */
async function fetchAgentia(
  repo: string,
  baseRef: string,
  story: Story,
): Promise<{ deps: AgentiaDependencies; error?: string }> {
  try {
    const deps = await listDependencies({
      cwd: repo,
      baseRef,
      pipelineId: story.pipelineId,
      sourceOrgId: story.sourceOrgId,
      sourceCredentialId: story.sourceCredential,
    });
    return { deps };
  } catch (error) {
    if (error instanceof AgentiaError && error.auth) throw error;
    return { deps: EMPTY_AGENTIA, error: (error as Error).message };
  }
}
