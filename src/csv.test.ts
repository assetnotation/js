/**
 * The spreadsheet bridge. Most of this file is about the two things that decide
 * whether someone outside an English-speaking office can use the format at all:
 * a semicolon separating columns, and a comma inside a number.
 */

import { describe, it, expect } from 'vitest';
import { fromCsv, toCsv } from './csv.js';
import { netWorth } from './wealth.js';
import { validate, supportedVersions } from './validate.js';

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

		// The other half of the same habit, and the one that costs: a German or
		// Spanish sheet groups thousands with a DOT. Read as the English shape it
		// gives "1.23456", a balance a thousand times too small, and nothing
		// fails. Position decides: the rightmost mark is the decimal one.
		const de = fromCsv('label;amount\nA;1.234,56\n', { generatedAt: STAMP });
		expect(
			((de.valuations as Record<string, unknown>[])[0].value as Record<string, unknown>).amount
		).toBe('1234.56');

		// More than one group, both ways round.
		const millions = fromCsv('label;amount\nA;1.234.567,89\nB;"2,345,678.90"\n', {
			generatedAt: STAMP
		});
		expect(
			(millions.valuations as Record<string, unknown>[]).map(
				(v) => (v.value as Record<string, unknown>).amount
			)
		).toEqual(['1234567.89', '2345678.90']);
	});

	it('reads an amount saved in a currency format, sign and all', () => {
		// "12 345,67 EUR-sign" is what a cell formatted as currency exports. The
		// sign used to stay glued to the number and the document was invalid.
		const doc = fromCsv(
			'label;currency;amount\n' +
				'Livret;;12 345,67 \u20AC\n' +
				'Brokerage;;$1,234.50\n' +
				'Savings;GBP;\u00A3 980,00\n' +
				'Loan;;EUR -1 000\n',
			{ generatedAt: STAMP }
		);
		const values = (doc.valuations as Record<string, unknown>[]).map(
			(v) => v.value as Record<string, unknown>
		);
		expect(values.map((v) => v.amount)).toEqual(['12345.67', '1234.50', '980.00', '-1000']);
		expect(values.map((v) => v.currency)).toEqual(['EUR', 'USD', 'GBP', 'EUR']);
		expect(validate(doc).valid).toBe(true);
	});

	it('takes the currency from the sign over a document default, never over the column', () => {
		const signed = fromCsv('label;amount\nBrokerage;$12\n', {
			generatedAt: STAMP,
			baseCurrency: 'EUR'
		});
		const v = (signed.valuations as Record<string, unknown>[])[0].value as Record<string, unknown>;
		expect(v).toEqual({ amount: '12', currency: 'USD' });

		// A sign that contradicts its own row is not resolved by guessing: the raw
		// text stays, and validation says so, instead of a balance changing currency.
		const contradicted = fromCsv('label;currency;amount\nBrokerage;USD;12 \u20AC\n', {
			generatedAt: STAMP
		});
		expect(validate(contradicted).valid).toBe(false);
	});

	it('reads the dates a spreadsheet writes, day first where the columns say so', () => {
		// A French or German sheet dates a row "24/06/2026" or "24.06.2026", and
		// the row used to reach the document as written, where the schema
		// refuses it. When both readings fit, the delimiter decides, as for an
		// amount: a semicolon comes from a sheet that writes the day first.
		const european = fromCsv(
			'label;amount;asOf\nA;1;24/06/2026\nB;2;24.06.2026\nC;3;3/6/2026\nD;4;2026-06-24\n',
			{ generatedAt: STAMP }
		);
		expect((european.valuations as Record<string, unknown>[]).map((v) => v.asOf)).toEqual([
			'2026-06-24',
			'2026-06-24',
			'2026-06-03',
			'2026-06-24'
		]);
		expect(validate(european).valid).toBe(true);

		const american = fromCsv('label,amount,asOf\nA,1,06/24/2026\nB,2,3/6/2026\nC,3,24/06/2026\n', {
			generatedAt: STAMP
		});
		expect((american.valuations as Record<string, unknown>[]).map((v) => v.asOf)).toEqual([
			'2026-06-24',
			'2026-03-06',
			'2026-06-24'
		]);

		// A date in no shape this reads is kept as written, for validate to refuse.
		const odd = fromCsv('label;amount;asOf\nA;1;June 2026\n', { generatedAt: STAMP });
		expect((odd.valuations as Record<string, unknown>[])[0].asOf).toBe('June 2026');
		expect(validate(odd).valid).toBe(false);
	});

	it('reads a currency column that holds a sign rather than a code', () => {
		const doc = fromCsv('label;currency;amount\nA;\u20AC;10\nB;usd;20\n', { generatedAt: STAMP });
		expect((doc.holdings as Record<string, unknown>[]).map((h) => h.currency)).toEqual([
			'EUR',
			'USD'
		]);
		expect(validate(doc).valid).toBe(true);
	});

	it('declares the newest version this build validates', () => {
		const doc = fromCsv('label;amount\nA;1\n', { generatedAt: STAMP });
		expect(doc.assetnotation).toBe(supportedVersions().at(-1));
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

	it('reads a debt printed as a negative balance as what is owed, and subtracts it', () => {
		const doc = fromCsv(
			'label;nature;currency;amount;asOf\n' +
				'Compte;asset;EUR;10,00;2026-06-24\n' +
				'Prêt;liability;EUR;-90000,00;2026-06-24\n',
			{ generatedAt: STAMP }
		);
		expect((doc.valuations as { value: { amount: string } }[])[1].value.amount).toBe('90000.00');
		expect(netWorth(doc).byCurrency).toEqual([
			{ currency: 'EUR', assets: '10.00', liabilities: '90000.00', net: '-89990.00' }
		]);
	});

	it('writes a text cell a spreadsheet would run as text, and reads it back unchanged', () => {
		const doc = fromCsv('label;institution;amount\n"=HYPERLINK(""x"")";+Banque;-5\n', {
			generatedAt: STAMP
		});
		const csv = toCsv(doc);
		const row = csv.split('\n')[1];
		expect(row).toContain(`'=HYPERLINK`);
		expect(row).toContain(`;'+Banque;`);
		expect(row).toContain(';-5;');
		const back = fromCsv(csv, { generatedAt: STAMP });
		expect((back.holdings as { label: string }[])[0].label).toBe('=HYPERLINK("x")');
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

	it('dates an undated row with the document stamp when no option gives one', () => {
		const doc = fromCsv('label;amount\nCompte;12.50\n');
		const valuations = doc.valuations as { asOf: string }[];
		expect(valuations[0].asOf).toBe(String(doc.generatedAt).slice(0, 10));
		expect(validate(doc).valid).toBe(true);
	});

	it('reads back a label that spans several lines', () => {
		const doc = {
			assetnotation: '0.3.0',
			generatedAt: STAMP,
			holdings: [
				{ id: 'h1', kind: 'checking', nature: 'asset', label: 'Compte\njoint', currency: 'EUR' },
				{ id: 'h2', kind: 'savings', nature: 'asset', label: 'Livret', currency: 'EUR' }
			]
		};
		const back = fromCsv(toCsv(doc), { generatedAt: STAMP });
		const labels = (back.holdings as { label: string }[]).map((h) => h.label);
		expect(labels).toEqual(['Compte\njoint', 'Livret']);
	});

	it('refuses an unclosed quote', () => {
		expect(() => fromCsv('label;amount\n"Compte;12\n', { generatedAt: STAMP })).toThrow(
			/unclosed quote/
		);
	});

	it('takes the latest valuation by instant, offsets included', () => {
		const doc = {
			assetnotation: '0.3.0',
			generatedAt: STAMP,
			holdings: [{ id: 'h1', kind: 'checking', nature: 'asset', label: 'Compte', currency: 'EUR' }],
			valuations: [
				{
					id: 'v1',
					holdingId: 'h1',
					asOf: '2026-06-23T23:30:00Z',
					value: { amount: '2.00', currency: 'EUR' }
				},
				{
					id: 'v2',
					holdingId: 'h1',
					asOf: '2026-06-24T01:00:00+02:00',
					value: { amount: '1.00', currency: 'EUR' }
				}
			]
		};
		expect(toCsv(doc).trim().split('\n')[1]).toContain('2.00');
	});

	it('refuses a row wider than its header instead of dropping the cents', () => {
		expect(() => fromCsv('label,amount\nSavings,1234,56\n', { generatedAt: STAMP })).toThrow(
			/row 2 has 3 columns and the header 2/
		);
	});

	it('refuses a header that names a column twice', () => {
		expect(() => fromCsv('label;amount;amount\nSavings;12;13\n', { generatedAt: STAMP })).toThrow(
			/names the column "amount" twice/
		);
	});

	it('refuses a header with neither a label nor an amount column', () => {
		expect(() => fromCsv('libelle;montant\nCompte;12\n', { generatedAt: STAMP })).toThrow(
			/neither a label nor an amount/
		);
	});

	it('keeps an unknown nature for validate to refuse, not as an asset', () => {
		const doc = fromCsv('label;amount;nature\nPret;100;liabilty\n', { generatedAt: STAMP });
		expect((doc.holdings as { nature: string }[])[0].nature).toBe('liabilty');
		expect(validate(doc).valid).toBe(false);
	});

	it('writes the currency of the amount it writes, not the holding one', () => {
		const doc = {
			assetnotation: '0.3.0',
			generatedAt: STAMP,
			holdings: [
				{ id: 'h1', kind: 'brokerage', nature: 'asset', label: 'Titres', currency: 'EUR' }
			],
			valuations: [
				{
					id: 'v1',
					holdingId: 'h1',
					asOf: '2026-06-24',
					value: { amount: '100.00', currency: 'USD' }
				}
			]
		};
		const row = toCsv(doc).trim().split('\n')[1];
		expect(row).toContain('USD');
		expect(row).not.toContain('EUR');
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
