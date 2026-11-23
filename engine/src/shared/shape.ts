// Pure helpers over a recipe's structure. No Node imports: the workflow bundle uses these.
import type { Recipe, Step } from "./types.js";

/** All steps in execution order (blocks flattened). Fallback-only steps are included; callers skip them. */
export function flatSteps(recipe: Recipe): Step[] {
  return recipe.blocks.flatMap((b) => b.steps);
}

export function findStep(recipe: Recipe, id: string): Step | undefined {
  const walk = (steps: Step[]): Step | undefined => {
    for (const s of steps) {
      if (s.id === id) return s;
      if (s.steps) {
        const inner = walk(s.steps);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  return walk(flatSteps(recipe));
}

export function isOpenStep(step: Step): boolean {
  return !step.uses && step.type !== "approval" && !step.foreach;
}

export function allSteps(recipe: Recipe): Step[] {
  const out: Step[] = [];
  const walk = (steps: Step[]) => steps.forEach((s) => (out.push(s), s.steps && walk(s.steps)));
  walk(flatSteps(recipe));
  return out;
}
