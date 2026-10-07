import { getWorkItem } from "./agentia.js";
import type { Story } from "./types.js";

// Copado feature branches are named feature/US-0000024.
const FEATURE_BRANCH = /^feature\/(US-\d+)(?:$|[/_-])/i;
const ANY_STORY = /(?:^|[/_-])(US-\d+)(?:$|[/_-])/i;
// Story names (US-0000024) or Salesforce record IDs. Also keeps the ID from being read as an option.
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Infers the user story from a branch name such as feature/US-0000024, if it contains one. */
export function inferStoryId(branch: string): string | undefined {
  const match = FEATURE_BRANCH.exec(branch) ?? ANY_STORY.exec(branch);
  return match?.[1]?.toUpperCase();
}

/** Picks the story from --story or the current branch, or throws telling the user to pass --story. */
export function resolveStoryId(explicit: string | undefined, branch: string): string {
  const id = explicit?.trim() || inferStoryId(branch);
  if (id === undefined) {
    const where = branch ? `branch "${branch}"` : "a detached HEAD";
    throw new Error(`Couldn't infer a user story from ${where}. Pass it explicitly, e.g. --story US-0000024`);
  }
  if (!STORY_ID.test(id)) throw new Error(`"${id}" is not a valid user story ID.`);
  return id;
}

/**
 * Loads the user story from Agentia. The pipeline, source org and source credential are required to ask
 * Agentia for dependencies; everything else is optional context for the report.
 */
export async function loadStory(storyId: string, repo: string): Promise<Story> {
  const item = await getWorkItem(storyId, repo);
  const missing = (["pipelineId", "sourceOrgId", "sourceCredential"] as const).filter((key) => item[key] === undefined);
  const { pipelineId, sourceOrgId, sourceCredential } = item;
  if (pipelineId === undefined || sourceOrgId === undefined || sourceCredential === undefined) {
    throw new Error(
      `User story ${storyId} has no ${missing.join(", ")} in Copado. ` +
        "Assign it to a pipeline and source environment before scanning.",
    );
  }
  return {
    name: item.name ?? storyId,
    recordId: item.id,
    title: item.title,
    pipelineId,
    sourceOrgId,
    sourceCredential,
    baseBranch: item.baseBranch,
    sourceEnvironmentName: item.sourceEnvironmentName,
    functionalRequirements: item.functionalRequirements,
    technicalSpecifications: item.technicalSpecifications,
  };
}
