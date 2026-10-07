/** Whether an external program RippleScope relies on can be run, with its version or the reason it can't. */
export type ToolStatus =
  | { ok: true; version: string }
  | { ok: false; error: string };

/** How a file differs from the base: on the branch, in the index, in the working tree, or not tracked yet. */
export type ChangeState = "committed" | "staged" | "unstaged" | "untracked";

export interface ChangedFile {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  states: ChangeState[];
}

/** A Salesforce metadata component, e.g. { type: "CustomField", name: "Account.Status__c" }. */
export interface ComponentRef {
  type: string;
  name: string;
}

export interface ChangedComponent extends ComponentRef {
  files: string[];
  states: ChangeState[];
}

/** One component Agentia reported, with the components around it in the deployed org. */
export interface AgentiaNode {
  component: ComponentRef;
  supported: boolean;
  /** Components that use this one (Agentia's `u`). */
  consumers: ComponentRef[];
  /** Components this one depends on (Agentia's `d`). */
  dependencies: ComponentRef[];
}

export interface AgentiaDependencies {
  nodes: AgentiaNode[];
  /** Components Agentia couldn't analyse, as readable labels. */
  notSupported: string[];
  transactionId?: string;
}

export type EdgeSource = "agentia" | "local";

/** `from` depends on `to`. */
export interface DependencyEdge {
  from: ComponentRef;
  to: ComponentRef;
  provenance: EdgeSource[];
  /** Where local analysis found the reference, e.g. "classes/Foo.cls:12  return a.Status__c;". */
  evidence?: string;
}

/** The fields RippleScope needs from a Copado user story. */
export interface Story {
  /** The user story name, e.g. US-0000024. */
  name: string;
  recordId?: string;
  title?: string;
  pipelineId: string;
  sourceOrgId: string;
  sourceCredential: string;
  baseBranch?: string;
  sourceEnvironmentName?: string;
  functionalRequirements?: string;
  technicalSpecifications?: string;
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface RiskReason {
  points: number;
  reason: string;
}

export interface Risk {
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
}

export interface Recommendation {
  kind: "run-test" | "add-test" | "verify-consumer" | "verify-new-dependency" | "deploy-together" | "stage-changes" | "include-in-release";
  message: string;
}

export interface ScanResult {
  story: Story;
  repo: {
    path: string;
    branch: string;
    baseRef: string;
    changedFiles: ChangedFile[];
    /** Changed files that aren't Salesforce metadata RippleScope recognises. */
    ignoredFiles: string[];
  };
  changedComponents: ChangedComponent[];
  agentia: {
    ok: boolean;
    transactionId?: string;
    notSupported: string[];
    error?: string;
  };
  agentiaDependencies: AgentiaNode[];
  localDependencies: DependencyEdge[];
  mergedEdges: DependencyEdge[];
  blastRadius: ComponentRef[];
  risk: Risk;
  recommendations: Recommendation[];
  warnings: string[];
}
