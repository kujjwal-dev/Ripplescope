import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentiaNode, ChangedComponent, ChangedFile, ComponentRef, DependencyEdge } from "./types.js";

// --- Salesforce source paths → components ------------------------------------------------------

interface PathRule {
  /** Matched against the path's trailing segments. Captures build the component name. */
  pattern: RegExp;
  type: string;
  name: (match: RegExpExecArray) => string;
}

// Source-format layout: force-app/main/default/<folder>/... Rules match from the metadata folder down,
// so package directories other than force-app work too. Apex's -meta.xml companions map to the same
// component as the .cls/.trigger file and are merged with it.
const PATH_RULES: readonly PathRule[] = [
  { pattern: /(?:^|\/)classes\/([^/]+)\.cls(?:-meta\.xml)?$/, type: "ApexClass", name: (m) => m[1]! },
  { pattern: /(?:^|\/)triggers\/([^/]+)\.trigger(?:-meta\.xml)?$/, type: "ApexTrigger", name: (m) => m[1]! },
  {
    pattern: /(?:^|\/)objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/,
    type: "CustomField",
    name: (m) => `${m[1]}.${m[2]}`,
  },
  {
    pattern: /(?:^|\/)objects\/([^/]+)\/validationRules\/([^/]+)\.validationRule-meta\.xml$/,
    type: "ValidationRule",
    name: (m) => `${m[1]}.${m[2]}`,
  },
  { pattern: /(?:^|\/)objects\/([^/]+)\/\1\.object-meta\.xml$/, type: "CustomObject", name: (m) => m[1]! },
  { pattern: /(?:^|\/)layouts\/([^/]+)\.layout-meta\.xml$/, type: "Layout", name: (m) => m[1]! },
  { pattern: /(?:^|\/)flows\/([^/]+)\.flow-meta\.xml$/, type: "Flow", name: (m) => m[1]! },
  {
    pattern: /(?:^|\/)permissionsets\/([^/]+)\.permissionset-meta\.xml$/,
    type: "PermissionSet",
    name: (m) => m[1]!,
  },
  { pattern: /(?:^|\/)lwc\/([^/]+)\/[^/]+$/, type: "LightningComponentBundle", name: (m) => m[1]! },
  { pattern: /(?:^|\/)aura\/([^/]+)\/[^/]+$/, type: "AuraDefinitionBundle", name: (m) => m[1]! },
];

/** Maps a source-format path to the Salesforce component it defines, or undefined if it isn't one we know. */
export function componentForPath(filePath: string): ComponentRef | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  for (const rule of PATH_RULES) {
    const match = rule.pattern.exec(normalized);
    if (match) return { type: rule.type, name: rule.name(match) };
  }
  return undefined;
}

/** Groups changed files into the components they define. Returns the components and the files that aren't metadata. */
export function toChangedComponents(files: readonly ChangedFile[]): {
  components: ChangedComponent[];
  ignoredFiles: string[];
} {
  const components = new Map<string, ChangedComponent>();
  const ignoredFiles: string[] = [];
  for (const file of files) {
    const ref = componentForPath(file.path);
    if (ref === undefined) {
      ignoredFiles.push(file.path);
      continue;
    }
    const component = components.get(componentKey(ref)) ?? { ...ref, files: [], states: [] };
    component.files.push(file.path);
    component.states = union(component.states, file.states);
    components.set(componentKey(ref), component);
  }
  return { components: [...components.values()], ignoredFiles };
}

// --- Local (prospective) references -------------------------------------------------------------

/**
 * Finds references a component's source makes to other components. The regex-based Apex finder below is
 * deliberately simple; a real Apex parser can replace it by implementing this interface.
 */
export interface ReferenceFinder {
  /** Component types whose source this finder can read. */
  readonly sourceTypes: ReadonlySet<string>;
  find(source: ComponentRef, code: string, candidates: readonly ComponentRef[]): LocalReference[];
}

export interface LocalReference {
  to: ComponentRef;
  line: number;
  text: string;
}

const APEX_TYPES = new Set(["ApexClass", "ApexTrigger"]);

/** Word-boundary token matching over Apex with comments and string literals blanked out. Apex is case-insensitive. */
export const apexReferenceFinder: ReferenceFinder = {
  sourceTypes: APEX_TYPES,
  find(source, code, candidates) {
    const lines = blankCommentsAndStrings(code).split("\n");
    const originalLines = code.split(/\r?\n/);
    const found: LocalReference[] = [];
    for (const candidate of candidates) {
      if (sameComponent(candidate, source)) continue;
      const token = apexToken(candidate);
      if (token === undefined) continue;
      const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(token)}(?![\\w$])`, "i");
      const index = lines.findIndex((line) => pattern.test(line));
      if (index !== -1) found.push({ to: candidate, line: index + 1, text: originalLines[index]?.trim() ?? "" });
    }
    return found;
  },
};

/** The identifier Apex code uses to refer to a component, if it can refer to it directly. */
function apexToken(component: ComponentRef): string | undefined {
  switch (component.type) {
    case "ApexClass":
    case "CustomObject":
      return component.name;
    case "CustomField": {
      // Apex refers to a field by its API name: record.Copado_Status__c. Standard fields (no __c) are too
      // generic to match without a parser.
      const field = component.name.split(".").pop() ?? "";
      return /__c$/i.test(field) ? field : undefined;
    }
    default:
      return undefined;
  }
}

/** Replaces comments and string literals with spaces, keeping line breaks so line numbers still match. */
function blankCommentsAndStrings(code: string): string {
  let out = "";
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  while (i < code.length) {
    const rest = code.slice(i, i + 2);
    let end: number;
    if (rest === "//") {
      end = code.indexOf("\n", i);
      end = end === -1 ? code.length : end;
    } else if (rest === "/*") {
      end = code.indexOf("*/", i + 2);
      end = end === -1 ? code.length : end + 2;
    } else if (code[i] === "'") {
      end = i + 1;
      while (end < code.length && code[end] !== "'" && code[end] !== "\n") end += code[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, code.length);
    } else {
      out += code[i];
      i += 1;
      continue;
    }
    out += blank(code.slice(i, end));
    i = end;
  }
  return out.replaceAll("\r", "");
}

/**
 * Reads each changed component's local source and finds references to the other changed components.
 * These edges describe the code as it is on disk, so they can include relationships the deployed org
 * (and therefore Agentia) doesn't know about yet.
 */
export async function findLocalDependencies(
  repo: string,
  components: readonly ChangedComponent[],
  finders: readonly ReferenceFinder[] = [apexReferenceFinder],
): Promise<DependencyEdge[]> {
  const edges: DependencyEdge[] = [];
  for (const component of components) {
    const finder = finders.find((f) => f.sourceTypes.has(component.type));
    if (finder === undefined) continue;
    for (const file of component.files.filter(isSourceFile)) {
      let code: string;
      try {
        code = await readFile(path.join(repo, file), "utf8");
      } catch {
        continue; // Deleted in the working tree: nothing local to analyse.
      }
      for (const ref of finder.find(component, code, components)) {
        edges.push({
          from: refOf(component),
          to: ref.to,
          provenance: ["local"],
          evidence: `${file}:${ref.line}  ${ref.text}`,
        });
      }
    }
  }
  return edges;
}

/** True for a component's code file rather than its -meta.xml companion. */
function isSourceFile(file: string): boolean {
  return !file.endsWith("-meta.xml");
}

/** Whether the local source of a changed Apex class marks it as a test. */
export async function findLocalTestClasses(repo: string, components: readonly ChangedComponent[]): Promise<Set<string>> {
  const tests = new Set<string>();
  for (const component of components.filter((c) => c.type === "ApexClass")) {
    for (const file of component.files.filter(isSourceFile)) {
      const code = await readFile(path.join(repo, file), "utf8").catch(() => "");
      if (/@isTest\b/i.test(blankCommentsAndStrings(code))) tests.add(componentKey(component));
    }
  }
  return tests;
}

/** Apex test classes: marked @IsTest in local source, or named like one (FooTest, FooTests, TestFoo). */
export function isTestClass(component: ComponentRef, localTests: ReadonlySet<string>): boolean {
  if (component.type !== "ApexClass") return false;
  return localTests.has(componentKey(component)) || /(?:^Test[A-Z_]|Tests?$)/.test(component.name);
}

// --- Graph ----------------------------------------------------------------------------------------

/** Turns Agentia's per-component view into edges: each consumer depends on the component, which depends on its dependencies. */
export function agentiaEdges(nodes: readonly AgentiaNode[]): DependencyEdge[] {
  return nodes.flatMap((node) => [
    ...node.consumers.map((consumer) => ({ from: consumer, to: node.component, provenance: ["agentia" as const] })),
    ...node.dependencies.map((dependency) => ({ from: node.component, to: dependency, provenance: ["agentia" as const] })),
  ]);
}

/** Merges edge lists, combining the provenance (and keeping the evidence) of edges that appear more than once. */
export function mergeEdges(...lists: DependencyEdge[][]): DependencyEdge[] {
  const merged = new Map<string, DependencyEdge>();
  for (const edge of lists.flat()) {
    const key = `${componentKey(edge.from)}->${componentKey(edge.to)}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...edge, provenance: [...edge.provenance] });
      continue;
    }
    existing.provenance = union(existing.provenance, edge.provenance);
    existing.evidence ??= edge.evidence;
  }
  // Agentia first, then local, for a stable and readable order.
  const order = (edge: DependencyEdge) => (edge.provenance.includes("agentia") ? 0 : 1);
  return [...merged.values()].sort((a, b) => order(a) - order(b));
}

/** Edges found only by local analysis: dependencies the deployed org doesn't have yet. */
export function prospectiveEdges(edges: readonly DependencyEdge[]): DependencyEdge[] {
  return edges.filter((edge) => !edge.provenance.includes("agentia"));
}

/** Every component a change can reach: the changed components first, then everything connected to them. */
export function blastRadius(changed: readonly ComponentRef[], edges: readonly DependencyEdge[]): ComponentRef[] {
  const seen = new Map<string, ComponentRef>();
  for (const component of [...changed, ...edges.flatMap((edge) => [edge.from, edge.to])]) {
    if (!seen.has(componentKey(component))) seen.set(componentKey(component), refOf(component));
  }
  return [...seen.values()];
}

// --- Helpers --------------------------------------------------------------------------------------

/** Salesforce API names are case-insensitive, so component identity is too. */
export function componentKey(component: ComponentRef): string {
  return `${component.type}:${component.name}`.toLowerCase();
}

export function sameComponent(a: ComponentRef, b: ComponentRef): boolean {
  return componentKey(a) === componentKey(b);
}

function refOf(component: ComponentRef): ComponentRef {
  return { type: component.type, name: component.name };
}

function union<T>(a: readonly T[], b: readonly T[]): T[] {
  return [...new Set([...a, ...b])];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
