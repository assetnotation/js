import { describe, it, expect } from 'vitest';
import { mergeCsv, netWorth, upsertHolding } from './wealth.js';

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

describe('ids already in use', () => {
	it('never mints an id a valuation already points at', () => {
		const partial = {
			valuations: [
				{ id: 'v1', holdingId: 'h1', asOf: '2026-01-01', value: { amount: '500', currency: 'EUR' } }
			]
		} as unknown as AssetNotationDocument;
		const { holding } = upsertHolding(partial, { label: 'Livret' });
		expect(holding.id).not.toBe('h1');
	});

	it('keeps two holdings the sheet named apart, under the same label', () => {
		const { doc } = mergeCsv({}, 'id;label;amount\ncompte-a;Réserve;100\ncompte-b;Réserve;200\n', {
			baseCurrency: 'EUR'
		});
		const holdings = (doc.holdings ?? []) as { id: string }[];
		expect(holdings.map((h) => h.id).sort()).toEqual(['compte-a', 'compte-b']);
		const valuations = (doc.valuations ?? []) as { holdingId: string; value: { amount: string } }[];
		expect(valuations.map((v) => [v.holdingId, v.value.amount])).toEqual([
			['compte-a', '100'],
			['compte-b', '200']
		]);
	});
});

describe('netWorth on a large portfolio', () => {
	it('adds 20 000 accounts in one currency without copying the list each time', () => {
		const n = 20_000;
		const holdings = Array.from({ length: n }, (_, i) => ({
			id: `h${i}`,
			kind: 'other',
			nature: 'asset'
		}));
		const valuations = holdings.map((h, i) => ({
			id: `v${i}`,
			holdingId: h.id,
			asOf: '2026-01-01',
			value: { amount: '1', currency: 'EUR' }
		}));
		const doc = { holdings, valuations } as unknown as AssetNotationDocument;
		const started = performance.now();
		const net = netWorth(doc);
		// Measured on 2026-11-13: 41 ms in place, 1 202 ms when each holding copied the list.
		expect(performance.now() - started).toBeLessThan(500);
		expect(net.byCurrency[0].net).toMatch(/^20000(\.0+)?$/);
	});
});
