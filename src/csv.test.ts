/**
 * The spreadsheet bridge. Most of this file is about the two things that decide
 * whether someone outside an English-speaking office can use the format at all:
 * a semicolon separating columns, and a comma inside a number.
 */

import { describe, it, expect } from 'vitest';
import { fromCsv, toCsv } from './csv.js';
import { validate } from './validate.js';

const STAMP = '2026-08-01T00:00:00Z';

describe('reading a spreadsheet as people actually save it', () => {
	it('reads a French export: semicolons between columns, commas inside numbers', () => {
		// The failure this prevents is silent and total: read as comma-separated,
		// "4210,55" becomes two columns and every balance is destroyed.
		const doc = fromCsv(
			'label;kind;nature;currency;institution;amount;asOf\n' +
				'Compte courant;checking;asset;EUR;Crédit Mutuel;4210,55;2026-06-24\n',
			{ generatedAt: STAMP }
		);

		expect(doc.holdings).toHaveLength(1);
		const v = (doc.valuations as Record<string, unknown>[])[0];
		expect((v.value as Record<string, unknown>).amount).toBe('4210.55');
		expect((doc.institutions as Record<string, unknown>[])[0].name).toBe('Crédit Mutuel');
	});

	it('reads an English export: commas between columns, dots inside numbers', () => {
		const doc = fromCsv('label,nature,currency,amount\nSavings,asset,USD,1200.40\n', {
			generatedAt: STAMP
		});
		const v = (doc.valuations as Record<string, unknown>[])[0];
		expect((v.value as Record<string, unknown>).amount).toBe('1200.40');
	});

	it('drops thousands grouping without touching the decimal mark', () => {
		const dot = fromCsv('label,amount\nA,"1,234.56"\n', { generatedAt: STAMP });
		expect(
			((dot.valuations as Record<string, unknown>[])[0].value as Record<string, unknown>).amount
		).toBe('1234.56');

		// The narrow no-break space French spreadsheets use for thousands.
		const fr = fromCsv('label;amount\nA;1 234,56\n', { generatedAt: STAMP });
		expect(
			((fr.valuations as Record<string, unknown>[])[0].value as Record<string, unknown>).amount
		).toBe('1234.56');
	});

	it('keeps an amount as a string, so no float rounds a balance', () => {
		const doc = fromCsv('label;amount\nA;0,10\nB;0,20\n', { generatedAt: STAMP });
		const amounts = (doc.valuations as Record<string, unknown>[]).map(
			(v) => (v.value as Record<string, unknown>).amount
		);
		expect(amounts).toEqual(['0.10', '0.20']);
	});

	it('honours quotes, so a label may contain the delimiter', () => {
		const doc = fromCsv('label;amount\n"Livret A; ancien";100\n', { generatedAt: STAMP });
		expect((doc.holdings as Record<string, unknown>[])[0].label).toBe('Livret A; ancien');
	});

	it('treats an unstated nature as an asset, never as a debt', () => {
		// A spreadsheet of balances is a list of assets. Guessing "liability"
		// would flip the sign of someone's net worth.
		const doc = fromCsv('label;amount\nA;100\n', { generatedAt: STAMP });
		expect((doc.holdings as Record<string, unknown>[])[0].nature).toBe('asset');
	});

	it('names one institution once, however many rows mention it', () => {
		const doc = fromCsv(
			'label;institution;amount\nA;Boursorama;1\nB;Boursorama;2\nC;Fortuneo;3\n',
			{ generatedAt: STAMP }
		);
		expect(doc.institutions).toHaveLength(2);
		const holdings = doc.holdings as Record<string, unknown>[];
		expect(holdings[0].institutionId).toBe(holdings[1].institutionId);
		expect(holdings[2].institutionId).not.toBe(holdings[0].institutionId);
	});

	it('skips the blank rows every real export ends with', () => {
		const doc = fromCsv('label;amount\nA;1\n;\n\n', { generatedAt: STAMP });
		expect(doc.holdings).toHaveLength(1);
	});

	it('produces a document this library itself accepts', () => {
		// The bar that matters: converting must not hand back something the
		// validator rejects, or the fault surfaces later and somewhere else.
		const doc = fromCsv(
			'label;kind;nature;currency;institution;amount;asOf\n' +
				'Compte;checking;asset;EUR;Banque;10,00;2026-06-24\n' +
				'Prêt;mortgage;liability;EUR;Banque;-90000,00;2026-06-24\n',
			{ generatedAt: STAMP, baseCurrency: 'EUR' }
		);
		const result = validate(doc);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it('refuses an empty file rather than inventing an empty document', () => {
		expect(() => fromCsv('   \n')).toThrow(/empty/);
	});
});

describe('writing a spreadsheet', () => {
	it('writes one row per holding, with what it was last worth', () => {
		const doc = {
			assetnotation: '0.3.0',
			generatedAt: STAMP,
			institutions: [{ id: 'i1', name: 'Banque' }],
			holdings: [{ id: 'h1', kind: 'checking', nature: 'asset', label: 'Compte', currency: 'EUR' }],
			valuations: [
				{
					id: 'v1',
					holdingId: 'h1',
					asOf: '2026-01-01',
					value: { amount: '1.00', currency: 'EUR' }
				},
				{
					id: 'v2',
					holdingId: 'h1',
					asOf: '2026-06-24',
					value: { amount: '4210.55', currency: 'EUR' }
				}
			]
		};
		const rows = toCsv(doc).trim().split('\n');
		expect(rows).toHaveLength(2);
		// The LATEST valuation, not the first one found.
		expect(rows[1]).toContain('4210.55');
		expect(rows[1]).toContain('2026-06-24');
	});

	it('keeps a holding that has never been valued', () => {
		// Dropping it would silently lose an account someone declared.
		const doc = {
			assetnotation: '0.3.0',
			generatedAt: STAMP,
			holdings: [{ id: 'h1', kind: 'other', nature: 'asset', label: 'Coffre' }]
		};
		expect(toCsv(doc).trim().split('\n')).toHaveLength(2);
	});

	it('quotes a label containing the delimiter, so the row survives a round trip', () => {
		const doc = {
			assetnotation: '0.3.0',
			generatedAt: STAMP,
			holdings: [{ id: 'h1', kind: 'other', nature: 'asset', label: 'A; B', currency: 'EUR' }],
			valuations: [
				{
					id: 'v1',
					holdingId: 'h1',
					asOf: '2026-06-24',
					value: { amount: '5.00', currency: 'EUR' }
				}
			]
		};
		const back = fromCsv(toCsv(doc), { generatedAt: STAMP });
		expect((back.holdings as Record<string, unknown>[])[0].label).toBe('A; B');
		expect(
			((back.valuations as Record<string, unknown>[])[0].value as Record<string, unknown>).amount
		).toBe('5.00');
	});
});
