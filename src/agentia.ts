import { z } from "zod";
import { CommandError, checkVersion, runCommand } from "./exec.js";
import type { AgentiaDependencies, AgentiaNode, ComponentRef, ToolStatus } from "./types.js";

// RippleScope only calls read-only Agentia commands (`work get`, `metadata dependency list`).
// Authentication comes from AGENTIA_CICD_API_KEY in the environment, which the child process inherits.
// RippleScope never reads, prints or stores the key itself.

const WORK_GET_TIMEOUT_MS = 60_000;
const DEPENDENCY_TIMEOUT_MS = 120_000;

/** Checks that the Copado Agentia Headless CLI is installed by running `agentia --version`. */
export function checkAgentia(): Promise<ToolStatus> {
  return checkVersion("agentia");
}

/** An Agentia command ran but reported a failure. `auth` is true when the API key is missing or rejected. */
export class AgentiaError extends Error {
  constructor(
    message: string,
    readonly auth: boolean,
  ) {
    super(message);
    this.name = "AgentiaError";
  }
}

// --- work get ----------------------------------------------------------------------------------

const optionalText = z.string().nullish().transform((value) => (value?.trim() ? value.trim() : undefined));

const WorkItemSchema = z.looseObject({
  id: optionalText,
  name: optionalText,
  title: optionalText,
  pipelineId: optionalText,
  sourceOrgId: optionalText,
  sourceCredential: optionalText,
  baseBranch: optionalText,
  sourceEnvironmentName: optionalText,
  functionalRequirements: optionalText,
  technicalSpecifications: optionalText,
});

export type WorkItem = z.infer<typeof WorkItemSchema>;

/** Runs `agentia cicd work get <storyId> --json` and returns the user story fields RippleScope uses. */
export async function getWorkItem(storyId: string, cwd: string): Promise<WorkItem> {
  const payload = await runAgentiaJson(["cicd", "work", "get", storyId, "--json"], cwd, WORK_GET_TIMEOUT_MS);
  return parseWorkItem(payload);
}

export function parseWorkItem(payload: unknown): WorkItem {
  // oclif's --json output is the command's return value; accept it bare or wrapped in `result`.
  const body = isRecord(payload) && isRecord(payload.result) ? payload.result : payload;
  const parsed = WorkItemSchema.safeParse(body);
  if (!parsed.success) {
    throw new AgentiaError(`Agentia returned a user story RippleScope couldn't read: ${z.prettifyError(parsed.error)}`, false);
  }
  return parsed.data;
}

// --- metadata dependency list ------------------------------------------------------------------

const RawComponentSchema = z.looseObject({
  n: z.string(),
  t: z.string(),
  supported: z.boolean().optional(),
});

const RawNodeSchema = RawComponentSchema.extend({
  u: z.array(RawComponentSchema).nullish(),
  d: z.array(RawComponentSchema).nullish(),
});

const DependencyResponseSchema = z.looseObject({
  result: z.looseObject({
    dependencies: z.array(RawNodeSchema).nullish(),
    notSupported: z.array(z.unknown()).nullish(),
  }),
  transactionId: z.string().optional(),
});

export interface DependencyRequest {
  /** The Salesforce repository; Agentia reads its committed and staged changes. */
  cwd: string;
  baseRef: string;
  pipelineId: string;
  sourceOrgId: string;
  sourceCredentialId: string;
}

/** Runs `agentia cicd metadata dependency list --from-changes` in the Salesforce repository. */
export async function listDependencies(request: DependencyRequest): Promise<AgentiaDependencies> {
  const args = [
    "cicd", "metadata", "dependency", "list",
    "--from-changes",
    "--base-ref", request.baseRef,
    "--retrieve-mode", "all",
    "--pipeline-id", request.pipelineId,
    "--source-org-id", request.sourceOrgId,
    "--source-credential-id", request.sourceCredentialId,
    "--json",
  ];
  const payload = await runAgentiaJson(args, request.cwd, DEPENDENCY_TIMEOUT_MS);
  return parseDependencies(payload);
}

/** Converts Agentia's abbreviated dependency format (n, t, u, d) into RippleScope's types. */
export function parseDependencies(payload: unknown): AgentiaDependencies {
  const parsed = DependencyResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AgentiaError(`Agentia returned dependency data RippleScope couldn't read: ${z.prettifyError(parsed.error)}`, false);
  }
  const { result, transactionId } = parsed.data;
  const nodes: AgentiaNode[] = (result.dependencies ?? []).map((raw) => ({
    component: toComponent(raw),
    supported: raw.supported ?? true,
    consumers: (raw.u ?? []).map(toComponent),
    dependencies: (raw.d ?? []).map(toComponent),
  }));
  return {
    nodes,
    notSupported: (result.notSupported ?? []).map(describeUnsupported),
    ...(transactionId === undefined ? {} : { transactionId }),
  };
}

function toComponent(raw: z.infer<typeof RawComponentSchema>): ComponentRef {
  return { type: raw.t, name: raw.n };
}

function describeUnsupported(entry: unknown): string {
  const component = RawComponentSchema.safeParse(entry);
  if (component.success) return `${component.data.t} ${component.data.n}`;
  return typeof entry === "string" ? entry : JSON.stringify(entry);
}

// --- running Agentia ---------------------------------------------------------------------------

const ErrorPayloadSchema = z.looseObject({
  error: z.looseObject({ message: z.string().optional() }),
});

/**
 * Runs an Agentia command with --json and returns the parsed JSON. Agentia reports some failures as
 * `{ "error": { "message": ... } }` with exit code 0, so the payload is checked as well as the exit code.
 */
async function runAgentiaJson(args: string[], cwd: string, timeoutMs: number): Promise<unknown> {
  let stdout: string;
  let failure: CommandError | undefined;
  try {
    ({ stdout } = await runCommand("agentia", args, { cwd, timeoutMs }));
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    failure = error;
    stdout = error.stdout;
  }

  const payload = extractJson(stdout);
  const reported = ErrorPayloadSchema.safeParse(payload);
  if (reported.success) throw agentiaFailure(reported.data.error.message ?? "Agentia reported an unknown error.");
  if (failure !== undefined) throw agentiaFailure(failure.message);
  if (payload === undefined) throw new AgentiaError(`"agentia ${args.slice(0, 4).join(" ")}" did not print JSON.`, false);
  return payload;
}

const AUTH_FAILURE = /api key|apikey|unauthori[sz]ed|forbidden|\b401\b|\b403\b|authenticat/i;

function agentiaFailure(message: string): AgentiaError {
  const safe = redactApiKey(message);
  if (AUTH_FAILURE.test(safe)) {
    return new AgentiaError(
      "Agentia authentication failed. Set the AGENTIA_CICD_API_KEY environment variable in this terminal " +
        `and try again. (Agentia said: ${safe})`,
      true,
    );
  }
  return new AgentiaError(`Agentia failed: ${safe}`, false);
}

/** Never let the API key reach the terminal, even if a downstream error message echoes it. */
function redactApiKey(text: string): string {
  const key = process.env.AGENTIA_CICD_API_KEY;
  return key && key.length >= 4 ? text.split(key).join("[redacted]") : text;
}

/** Parses stdout as JSON, tolerating notices printed around it. Returns undefined if there is none. */
function extractJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
