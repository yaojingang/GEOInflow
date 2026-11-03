import type { DecisionPlanner } from './consumer';
import { ingressPlanner } from './ingress-planner';

export function collectionPlanner(
  browser: DecisionPlanner,
  logs: DecisionPlanner,
  recorder?: DecisionPlanner,
  tasks?: DecisionPlanner,
): DecisionPlanner {
  return async (inputs, state, receipts) => {
    const logInputs = inputs.filter(i => i.envelope.kind === 'log');
    const recorderInputs = inputs.filter(i => ['replay', 'heatmap'].includes(i.envelope.kind));
    const browserInputs = inputs.filter(
      i => !['log', 'replay', 'heatmap', 'ingress', 'task'].includes(i.envelope.kind),
    );
    if (recorderInputs.length && !recorder) throw new Error('warehouse-recorder-planner-missing');
    const taskInputs = inputs.filter(i => i.envelope.kind === 'task');
    if (taskInputs.length && !tasks) throw new Error('warehouse-task-planner-missing');
    const decisions = [
      ...(taskInputs.length ? await tasks(taskInputs, state, receipts) : []),
      ...(await ingressPlanner(
        inputs.filter(i => i.envelope.kind === 'ingress'),
        state,
        receipts,
      )),
      ...(browserInputs.length ? await browser(browserInputs, state, receipts) : []),
      ...(logInputs.length ? await logs(logInputs, state, receipts) : []),
      ...(recorderInputs.length ? await recorder(recorderInputs, state, receipts) : []),
    ];
    const byInput = new Map(decisions.map(d => [d.input.envelope.inputId, d]));
    return inputs.map(i => {
      const decision = byInput.get(i.envelope.inputId);
      if (!decision) throw new Error('warehouse-planner-incomplete');
      return decision;
    });
  };
}
