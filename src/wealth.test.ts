import { describe, it, expect } from 'vitest';
import { upsertHolding } from './wealth.js';

type AssetNotationDocument = Parameters<typeof upsertHolding>[0];

/* Audit Codex 2026-11-11: an update that named one attribute replaced the
 * whole object, so changing a rate dropped the end date of the loan. */
describe('upsertHolding keeps what it was not told to change', () => {
	const loan = (): AssetNotationDocument =>
		({
			holdings: [
				{
					id: 'h1',
					kind: 'loan',
					nature: 'liability',
					attributes: { rate: '3', endDate: '2040-01-01' }
				}
			]
		}) as unknown as AssetNotationDocument;

	it('changes one attribute and keeps the others', () => {
		const { holding } = upsertHolding(loan(), { id: 'h1', attributes: { rate: '4' } });
		expect(holding.attributes).toEqual({ rate: '4', endDate: '2040-01-01' });
	});

	it('removes an attribute set to null, and all of them on attributes: null', () => {
		const one = upsertHolding(loan(), { id: 'h1', attributes: { endDate: null } });
		expect(one.holding.attributes).toEqual({ rate: '3' });
		const all = upsertHolding(loan(), { id: 'h1', attributes: null });
		expect(all.holding).not.toHaveProperty('attributes');
		const emptied = upsertHolding(loan(), { id: 'h1', attributes: { rate: null, endDate: null } });
		expect(emptied.holding).not.toHaveProperty('attributes');
	});

	it('leaves attributes alone when the input does not name them', () => {
		const { holding } = upsertHolding(loan(), { id: 'h1', label: 'Prêt immo' });
		expect(holding.attributes).toEqual({ rate: '3', endDate: '2040-01-01' });
	});

	it('gives a new holding the attributes it is created with', () => {
		const { holding } = upsertHolding({ holdings: [] } as unknown as AssetNotationDocument, {
			label: 'Livret',
			attributes: { rate: '2.4', ceiling: null }
		});
		expect(holding.attributes).toEqual({ rate: '2.4' });
	});
});
