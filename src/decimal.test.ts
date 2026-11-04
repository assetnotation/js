import { describe, it, expect } from 'vitest';
import { sumDecimals } from './decimal.js';

describe('sumDecimals', () => {
	/* Audit Codex 2026-11-04: the scale was a spread into Math.max, so a large
	 * portfolio passed more arguments than a call may take. */
	it('sums two hundred thousand amounts exactly, without throwing', () => {
		expect(sumDecimals(Array.from({ length: 200_000 }, () => '0.01'))).toBe('2000.00');
	});

	it('keeps the widest scale of its inputs', () => {
		expect(sumDecimals(['1.5', '2', '0.25'])).toBe('3.75');
	});
});
