/** Decides the container first-boot behavior from the saved configuration and pairing env. */
export type PairingDecision =
  | { action: 'skip' }
  | { action: 'missing-code' }
  | { action: 'invalid-code' }
  | { action: 'pair'; code: string };

export function pairingDecision(configured: boolean, rawCode: string | undefined): PairingDecision {
  if (configured) return { action: 'skip' };
  const code = (rawCode || '').trim();
  if (!code) return { action: 'missing-code' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return { action: 'invalid-code' };
  return { action: 'pair', code };
}
