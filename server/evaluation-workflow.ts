export const EVALUATOR_WORKFLOW = 'langgraph:measure->decide->cn-summary:index-v11-codex';

export function isEvaluationWorkflowCompatible(workflow?: string | null): boolean {
  if (!workflow) return false;
  const base = workflow.replace(/:needs-refresh:[^:]+$/, '').replace(/:fast-list$/, '');
  if (base === EVALUATOR_WORKFLOW) return true;
  if (/^langgraph:measure->decide->.+-cn-summary:index-v9$/.test(base)) return true;
  if (
    process.env.CURATOR_COMPATIBLE_LEGACY_WORKFLOWS !== '0' &&
    /^langgraph:measure->decide->.+-cn-summary:index-v8$/.test(base)
  ) {
    return true;
  }
  return false;
}

export function isEvaluationWorkflowComplete(workflow?: string | null): boolean {
  const value = workflow ?? '';
  return isEvaluationWorkflowCompatible(value) && !/:needs-refresh:[^:]+$/.test(value) && !/:fast-list$/.test(value);
}
