import { expect, it } from 'vitest';
import { pairingDecision } from './pairing-decision';

const code = 'a'.repeat(43);

it('keeps an existing configuration regardless of the pairing env', () => {
  expect(pairingDecision(true, code)).toEqual({ action: 'skip' });
  expect(pairingDecision(true, 'not-a-code')).toEqual({ action: 'skip' });
});

it('requires a code when the state directory has no configuration', () => {
  expect(pairingDecision(false, undefined)).toEqual({ action: 'missing-code' });
  expect(pairingDecision(false, '   ')).toEqual({ action: 'missing-code' });
});

it('rejects malformed pairing codes before any exchange', () => {
  expect(pairingDecision(false, 'short')).toEqual({ action: 'invalid-code' });
  expect(pairingDecision(false, `${code}!`)).toEqual({ action: 'invalid-code' });
});

it('pairs on first boot with a valid code and trims surrounding whitespace', () => {
  expect(pairingDecision(false, `  ${code}  `)).toEqual({ action: 'pair', code });
});
