import { componentKey, isTestClass, prospectiveEdges, sameComponent } from "./analyzer.js";
import type { AgentiaNode, ChangedComponent, ComponentRef, DependencyEdge, Recommendation, Risk, RiskLevel, RiskReason } from "./types.js";

// A deliberately simple, deterministic risk model. Every point is listed in the reasons, so the score can be
// explained line by line:
//
//   +10  per changed Salesforce component
//   +10  per component Agentia says consumes a change but that isn't itself part of the change
//   +10  per new (local-only) dependency from production code, which the deployed org doesn't have yet
//   +10  if production Apex (non-test class or trigger) changed
//   +15  if changed production Apex has no test class linked to it in the graph
//   +5   if a page layout is in the blast radius
//
// Capped at 100. LOW < 25 <= MEDIUM < 70 <= HIGH.

export const POINTS = {
  changedComponent: 10,
  externalConsumer: 10,
  prospectiveDependency: 10,
  productionApex: 10,
  untestedApex: 15,
  layout: 5,
} as const;

export interface ScoreInput {
  changed: readonly ChangedComponent[];
  agentiaNodes: readonly AgentiaNode[];
  edges: readonly DependencyEdge[];
  blastRadius: readonly ComponentRef[];
  /** Changed Apex classes whose local source is marked @IsTest (keys from componentKey). */
  localTests: ReadonlySet<string>;
}

export function scoreRisk(input: ScoreInput): Risk {
  const facts = analyse(input);
  const reasons: RiskReason[] = [];
  const add = (points: number, reason: string) => {
    if (points > 0) reasons.push({ points, reason });
  };

  add(input.changed.length * POINTS.changedComponent, `${plural(input.changed.length, "Salesforce component")} changed`);
  add(
    facts.externalConsumers.length * POINTS.externalConsumer,
    `${plural(facts.externalConsumers.length, "existing org component")} consume${facts.externalConsumers.length === 1 ? "s" : ""} the change: ${names(facts.externalConsumers)}`,
  );
  add(
    facts.productionProspective.length * POINTS.prospectiveDependency,
    `${plural(facts.productionProspective.length, "new dependency", "new dependencies")} not yet in the deployed org: ${facts.productionProspective.map(arrow).join(", ")}`,
  );
  add(facts.productionApex.length > 0 ? POINTS.productionApex : 0, `Production Apex changed: ${names(facts.productionApex)}`);
  add(facts.untestedApex.length > 0 ? POINTS.untestedApex : 0, `No test class linked to ${names(facts.untestedApex)}`);
  add(facts.layouts.length > 0 ? POINTS.layout : 0, `Page layout in the blast radius: ${names(facts.layouts)}`);

  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0));
  return { score, level: levelFor(score), reasons };
}

export function levelFor(score: number): RiskLevel {
  if (score >= 70) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

/** Deterministic next steps derived only from the graph — never suggests a test that isn't in it. */
export function recommend(input: ScoreInput): Recommendation[] {
  const facts = analyse(input);
  const out: Recommendation[] = [];

  for (const { test, covers } of facts.testsToRun) {
    const reason = covers.length > 0 ? ` (covers ${names(covers)})` : " (changed test class)";
    out.push({ kind: "run-test", message: `Run ${test.name}${reason}` });
  }
  for (const apex of facts.untestedApex) {
    out.push({ kind: "add-test", message: `Add or identify a test class for ${apex.name} — none is linked in the dependency graph` });
  }
  for (const { consumer, uses } of facts.consumerChecks) {
    out.push({ kind: "verify-consumer", message: `Verify ${label(consumer)} — it uses ${names(uses)}` });
  }
  for (const edge of facts.prospective) {
    out.push({ kind: "verify-new-dependency", message: `Verify new dependency ${arrow(edge)} (not in the deployed org yet)` });
  }
  for (const { target, sources } of facts.deployTogether) {
    out.push({ kind: "deploy-together", message: `Deploy ${target.name} in the same release as ${names(sources)}` });
  }
  if (facts.notVisibleToAgentia.length > 0) {
    out.push({
      kind: "stage-changes",
      message: `Stage or commit ${names(facts.notVisibleToAgentia)} so Agentia can analyse ${facts.notVisibleToAgentia.length === 1 ? "it" : "them"}`,
    });
  }
  if (input.changed.length > 0) {
    out.push({ kind: "include-in-release", message: `Include all changed metadata in the release: ${names(input.changed)}` });
  }
  return out;
}

// --- Facts shared by the score and the recommendations ------------------------------------------

function analyse({ changed, agentiaNodes, edges, blastRadius, localTests }: ScoreInput) {
  const changedKeys = new Set(changed.map(componentKey));
  const isChanged = (c: ComponentRef) => changedKeys.has(componentKey(c));
  const isTest = (c: ComponentRef) => isTestClass(c, localTests);

  const externalConsumers = uniq(
    agentiaNodes.flatMap((node) => node.consumers).filter((consumer) => !isChanged(consumer)),
  );

  const prospective = prospectiveEdges(edges);
  const productionProspective = prospective.filter((edge) => !isTest(edge.from));

  const productionApex = changed.filter(
    (c) => c.type === "ApexTrigger" || (c.type === "ApexClass" && !isTest(c)),
  );

  // A test is linked to Apex when either one references the other, in the org or locally.
  const linkedTests = (apex: ComponentRef) =>
    uniq(
      edges.flatMap((edge) => {
        if (sameComponent(edge.to, apex) && isTest(edge.from)) return [edge.from];
        if (sameComponent(edge.from, apex) && isTest(edge.to)) return [edge.to];
        return [];
      }),
    );
  const untestedApex = productionApex.filter((apex) => linkedTests(apex).length === 0);

  const testsToRun = uniq([
    ...productionApex.flatMap(linkedTests),
    ...changed.filter((c) => c.type === "ApexClass" && isTest(c)),
  ]).map((test) => ({
    test,
    covers: productionApex.filter((apex) => linkedTests(apex).some((t) => sameComponent(t, test))),
  }));

  // Unchanged, non-test components that depend on something changed.
  const consumerChecks = groupBy(
    edges.filter((edge) => isChanged(edge.to) && !isChanged(edge.from) && !isTest(edge.from)),
    (edge) => edge.from,
    (edge) => edge.to,
  ).map(({ key, values }) => ({ consumer: key, uses: values }));

  // New code that references other new metadata only deploys if they ship together.
  const deployTogether = groupBy(
    prospective.filter((edge) => isChanged(edge.from) && isChanged(edge.to)),
    (edge) => edge.to,
    (edge) => edge.from,
  ).map(({ key, values }) => ({ target: key, sources: values }));

  const notVisibleToAgentia = changed.filter((c) => c.states.every((s) => s === "unstaged" || s === "untracked"));

  const layouts = blastRadius.filter((c) => c.type === "Layout");

  return {
    externalConsumers,
    prospective,
    productionProspective,
    productionApex,
    untestedApex,
    testsToRun,
    consumerChecks,
    deployTogether,
    notVisibleToAgentia,
    layouts,
  };
}

function groupBy(
  edges: readonly DependencyEdge[],
  keyOf: (edge: DependencyEdge) => ComponentRef,
  valueOf: (edge: DependencyEdge) => ComponentRef,
): { key: ComponentRef; values: ComponentRef[] }[] {
  const groups = new Map<string, { key: ComponentRef; values: ComponentRef[] }>();
  for (const edge of edges) {
    const key = keyOf(edge);
    const group = groups.get(componentKey(key)) ?? { key, values: [] };
    group.values = uniq([...group.values, valueOf(edge)]);
    groups.set(componentKey(key), group);
  }
  return [...groups.values()];
}

function uniq<T extends ComponentRef>(components: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const c of components) if (!seen.has(componentKey(c))) seen.set(componentKey(c), c);
  return [...seen.values()];
}

function names(components: readonly ComponentRef[]): string {
  return components.map((c) => c.name).join(", ");
}

function label(component: ComponentRef): string {
  return component.type === "Layout" ? `layout ${component.name}` : `${component.type} ${component.name}`;
}

function arrow(edge: DependencyEdge): string {
  return `${edge.from.name} → ${edge.to.name}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
