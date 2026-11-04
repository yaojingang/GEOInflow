import type { DecisionPlanner } from './consumer';
import { factInput } from './fact-input';
export const ingressPlanner: DecisionPlanner = async inputs =>
  inputs.map(input => {
    const e = input.envelope;
    if (
      e.kind !== 'ingress' ||
      e.data.format !== 'ingress-v1' ||
      !['blocked_ip', 'invalid_ip'].includes(String(e.data.reason)) ||
      e.clientEventId
    )
      throw new Error('warehouse-invalid-ingress-package');
    const bucket = new Date(e.receivedAt);
    bucket.setUTCSeconds(0, 0);
    return {
      input,
      status: 'new',
      sessionId: null,
      visitId: null,
      facts: [
        {
          family: 'liekan_geography_ingress',
          row: factInput('liekan_geography_ingress', {
            website_id: e.websiteId,
            bucket,
            reason: e.data.reason,
            count: 1,
          }),
        },
      ],
    };
  });
