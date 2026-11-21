import type { DecisionPlanner } from './consumer';
import { ingressPlanner } from './ingress-planner';
import type { InputPosition } from './landing';
import { routingKey } from './routing';

function usesBrowserPlanner({ envelope }: InputPosition) {
  return !['log', 'replay', 'heatmap', 'ingress', 'task'].includes(envelope.kind);
}

export function collectionPlanner(
  browser: DecisionPlanner,
  logs: DecisionPlanner,
  recorder?: DecisionPlanner,
  tasks?: DecisionPlanner,
): DecisionPlanner {
  const plan: DecisionPlanner = async (inputs, state, receipts, trace) => {
    const logInputs = inputs.filter(i => i.envelope.kind === 'log');
    const recorderInputs = inputs.filter(i => ['replay', 'heatmap'].includes(i.envelope.kind));
    const browserInputs = inputs.filter(usesBrowserPlanner);
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
      ...(logInputs.length ? await logs(logInputs, state, receipts, trace) : []),
      ...(recorderInputs.length ? await recorder(recorderInputs, state, receipts) : []),
    ];
    const byInput = new Map(decisions.map(d => [d.input.envelope.inputId, d]));
    return inputs.map(i => {
      const decision = byInput.get(i.envelope.inputId);
      if (!decision) throw new Error('warehouse-planner-incomplete');
      return decision;
    });
  };
  // Only browserPlanner consumes identity receipts. Log deduplication uses
  // accepted facts, while exact input replay and deletion are handled upstream.
  plan.receiptKeys = inputs =>
    inputs
      .filter(i => i.envelope.clientEventId && usesBrowserPlanner(i))
      .map(i => routingKey(i.envelope));
  return plan;
}
