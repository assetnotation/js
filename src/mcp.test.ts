/**
 * The tools an assistant calls, exercised as functions on a temporary file.
 * The transport is the SDK's business; what is protected here is each tool's
 * answer, the bytes it leaves on disk, and that an invalid document never
 * reaches the file.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
	existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refusal, wealthTools, type Tool } from './mcp.js';
import { supportedVersions } from './validate.js';

const NOW = '2026-10-19T10:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'asset-notation-mcp-'));
let path: string;
let tools: Record<string, Tool>;
let n = 0;

function call(name: string, args: Record<string, unknown> = {}): unknown {
	return tools[name].run(args);
}

function refusal(name: string, args: Record<string, unknown> = {}): Refusal {
	try {
		call(name, args);
	} catch (error) {
		if (error instanceof Refusal) return error;
		throw error;
	}
	throw new Error(`${name} did not refuse`);
}

function stored(): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
	path = join(dir, `wealth-${++n}.json`);
	tools = Object.fromEntries(wealthTools(path, () => NOW).map((t) => [t.name, t]));
});

describe('the MCP tools', () => {
	it('exposes the seven tools, with a description an assistant can act on', () => {
		expect(Object.keys(tools).sort()).toEqual([
			'add_valuation',
			'import_csv',
			'list_holdings',
			'net_worth',
			'read_document',
			'upsert_holding',
			'validate'
		]);
		for (const tool of Object.values(tools)) expect(tool.description.length).toBeGreaterThan(40);
	});

	it('upsert_holding creates a minimal valid document of the newest version', () => {
		expect(existsSync(path)).toBe(false);
		const holding = call('upsert_holding', {
			label: 'Current account',
			kind: 'checking',
			currency: 'EUR'
		});
		expect(holding).toEqual({
			id: 'h1',
			kind: 'checking',
			nature: 'asset',
			label: 'Current account',
			currency: 'EUR'
		});
		const doc = stored();
		expect(doc.assetnotation).toBe(supportedVersions().at(-1));
		expect(doc.generatedAt).toBe(NOW);
		expect(Object.keys(doc)).toEqual(['assetnotation', 'generatedAt', 'generator', 'holdings']);
		expect(call('validate')).toMatchObject({ valid: true });
	});

	it('writes the file whole, two-space indented, and the same bytes twice', () => {
		call('upsert_holding', { id: 'h1', label: 'A' });
		const first = readFileSync(path, 'utf8');
		expect(first.endsWith('}\n')).toBe(true);
		expect(first).toContain('\n  "holdings": [\n    {\n      "id": "h1"');
		call('upsert_holding', { id: 'h1', label: 'A' });
		expect(readFileSync(path, 'utf8')).toBe(first);
	});

	it('upsert_holding updates the fields given and keeps the rest', () => {
		call('upsert_holding', {
			id: 'flat',
			label: '12 Main St',
			kind: 'real_estate',
			currency: 'EUR'
		});
		const updated = call('upsert_holding', {
			id: 'flat',
			label: 'Flat, 12 Main St',
			institution: 'Example Bank'
		});
		expect(updated).toMatchObject({
			id: 'flat',
			kind: 'real_estate',
			currency: 'EUR',
			label: 'Flat, 12 Main St',
			institutionId: 'i1'
		});
		expect(stored().institutions).toEqual([{ id: 'i1', name: 'Example Bank' }]);
		expect(stored().holdings).toHaveLength(1);
		call('upsert_holding', {
			id: 'loan',
			nature: 'liability',
			kind: 'mortgage',
			institution: 'Example Bank'
		});
		expect(stored().institutions).toHaveLength(1);
	});

	it('refuses a write that would make the document invalid, and leaves the file as it was', () => {
		call('upsert_holding', { id: 'h1', label: 'A' });
		const before = readFileSync(path, 'utf8');
		const error = refusal('upsert_holding', { id: 'h2', currency: 'euros' });
		expect(error.message).toMatch(/invalid; nothing was written/);
		expect(error.details.join('\n')).toMatch(/\/holdings\/1\/currency must match pattern/);
		expect(readFileSync(path, 'utf8')).toBe(before);
	});

	it('add_valuation appends to the history and amounts stay strings', () => {
		call('upsert_holding', { id: 'h1', label: 'Savings', currency: 'EUR' });
		const v = call('add_valuation', {
			holdingId: 'h1',
			asOf: '2026-09-30',
			amount: '1000.00',
			currency: 'EUR'
		});
		expect(v).toEqual({
			id: 'v1',
			holdingId: 'h1',
			asOf: '2026-09-30',
			value: { amount: '1000.00', currency: 'EUR' }
		});
		call('add_valuation', {
			holdingId: 'h1',
			asOf: '2026-10-18',
			amount: '1010.25',
			currency: 'EUR',
			source: 'statement'
		});
		expect(stored().valuations).toHaveLength(2);
		expect(readFileSync(path, 'utf8')).toContain('"amount": "1010.25"');
	});

	it('add_valuation refuses a holding that is not there and a file that is not there', () => {
		expect(
			refusal('add_valuation', {
				holdingId: 'h9',
				asOf: '2026-01-01',
				amount: '1',
				currency: 'EUR'
			}).message
		).toMatch(/does not exist yet/);
		call('upsert_holding', { id: 'h1' });
		// An unresolved reference is a note, not an error: the document stays valid.
		call('add_valuation', { holdingId: 'h9', asOf: '2026-01-01', amount: '1', currency: 'EUR' });
		expect(call('validate')).toMatchObject({
			valid: true,
			notes: [expect.stringMatching(/valuation v1.holdingId "h9"/)]
		});
	});

	it('net_worth sums the latest valuation of each holding, exactly, per currency', () => {
		call('upsert_holding', { id: 'cash', kind: 'checking', currency: 'EUR' });
		call('upsert_holding', { id: 'flat', kind: 'real_estate', currency: 'EUR' });
		call('upsert_holding', { id: 'loan', kind: 'mortgage', nature: 'liability', currency: 'EUR' });
		call('upsert_holding', { id: 'usd', kind: 'brokerage', currency: 'USD' });
		call('upsert_holding', { id: 'empty', kind: 'other' });
		call('add_valuation', {
			holdingId: 'cash',
			asOf: '2026-09-01',
			amount: '100.10',
			currency: 'EUR'
		});
		call('add_valuation', {
			holdingId: 'cash',
			asOf: '2026-10-01',
			amount: '0.20',
			currency: 'EUR'
		});
		call('add_valuation', {
			holdingId: 'flat',
			asOf: '2026-06-01',
			amount: '300000',
			currency: 'EUR'
		});
		call('add_valuation', {
			holdingId: 'loan',
			asOf: '2026-10-01',
			amount: '176400.00',
			currency: 'EUR'
		});
		call('add_valuation', {
			holdingId: 'usd',
			asOf: '2026-10-01',
			amount: '1234.5',
			currency: 'USD'
		});
		expect(call('net_worth')).toEqual({
			byCurrency: [
				{ currency: 'EUR', assets: '300000.20', liabilities: '176400.00', net: '123600.20' },
				{ currency: 'USD', assets: '1234.5', liabilities: '0', net: '1234.5' }
			],
			oldestAsOf: '2026-06-01',
			unvaluedHoldingIds: ['empty'],
			valuedHoldings: 4
		});
	});

	it('list_holdings names the institution and the latest valuation', () => {
		call('upsert_holding', {
			id: 'h1',
			label: 'Savings',
			institution: 'Example Bank',
			currency: 'EUR'
		});
		call('add_valuation', {
			holdingId: 'h1',
			asOf: '2026-10-01',
			amount: '10',
			currency: 'EUR',
			source: 'statement'
		});
		expect(call('list_holdings')).toEqual([
			{
				id: 'h1',
				kind: 'other',
				nature: 'asset',
				label: 'Savings',
				currency: 'EUR',
				institutionId: 'i1',
				institution: 'Example Bank',
				latestValuation: {
					asOf: '2026-10-01',
					value: { amount: '10', currency: 'EUR' },
					source: 'statement'
				}
			}
		]);
	});

	it('read_document returns the file and refuses one that is not JSON', () => {
		call('upsert_holding', { id: 'h1' });
		expect(call('read_document')).toEqual(stored());
		writeFileSync(path, '{broken');
		expect(refusal('read_document').message).toMatch(/is not JSON/);
	});

	it('import_csv creates the file, merges by id or label, and never overwrites a stranger by coincidence', () => {
		const first = call('import_csv', {
			csv: 'label;amount;asOf;institution\nLivret;1 234,56;30/09/2026;Example Bank\n'
		});
		expect(first).toEqual({ holdingIds: ['h1'], valuations: 1 });
		expect(stored().holdings).toEqual([
			{
				id: 'h1',
				kind: 'other',
				nature: 'asset',
				currency: 'EUR',
				label: 'Livret',
				institutionId: 'i1'
			}
		]);

		call('upsert_holding', { id: 'h2', label: 'Flat', kind: 'real_estate' });
		// Rows: one matches h1 by label, one matches Flat by label, one is a stranger whose minted id h1 is taken.
		const second = call('import_csv', {
			csv: 'label,amount,asOf\nLivret,1300,2026-10-18\nFlat,300000,2026-10-18\nNew car,9000,2026-10-18\n'
		});
		expect(second).toEqual({ holdingIds: ['h1', 'h2', 'h3'], valuations: 3 });
		const holdings = stored().holdings as { id: string; label: string }[];
		expect(holdings.map((h) => [h.id, h.label])).toEqual([
			['h1', 'Livret'],
			['h2', 'Flat'],
			['h3', 'New car']
		]);
		expect(stored().valuations).toHaveLength(4);
		expect(call('net_worth')).toMatchObject({
			byCurrency: [{ currency: 'EUR', assets: '310300', liabilities: '0', net: '310300' }]
		});
	});

	it('import_csv keeps what the sheet does not say: a debt re-imported with label and amount stays a debt', () => {
		call('upsert_holding', {
			id: 'h1',
			label: 'Loan',
			kind: 'loan',
			nature: 'liability',
			currency: 'USD'
		});
		call('import_csv', { csv: 'label;amount;asOf\nLoan;90 000;2026-10-18\n' });
		expect(stored().holdings).toEqual([
			{ id: 'h1', kind: 'loan', nature: 'liability', currency: 'USD', label: 'Loan' }
		]);
	});

	it('import_csv matches a label only within the same institution', () => {
		call('import_csv', { csv: 'label;amount;asOf;institution\nSavings;100;2026-10-01;Bank A\n' });
		call('import_csv', { csv: 'label;amount;asOf;institution\nSavings;200;2026-10-01;Bank B\n' });
		const holdings = stored().holdings as { id: string; institutionId: string }[];
		expect(holdings.map((h) => [h.id, h.institutionId])).toEqual([
			['h1', 'i1'],
			['h2', 'i2']
		]);
		expect(call('net_worth')).toMatchObject({ byCurrency: [{ assets: '300' }] });
	});

	it('a write that fails leaves the previous file whole and no stray file', () => {
		call('upsert_holding', { id: 'h1', label: 'Livret' });
		const before = readFileSync(path, 'utf8');
		mkdirSync(`${path}.${process.pid}.tmp`);
		expect(() => call('upsert_holding', { id: 'h1', label: 'Livret A' })).toThrow();
		expect(readFileSync(path, 'utf8')).toBe(before);
	});

	it('a write leaves only the document in its folder', () => {
		call('upsert_holding', { id: 'h1', label: 'Livret' });
		const name = path.split(/[\\/]/).pop() as string;
		expect(readdirSync(dir).filter((f) => f.startsWith(name))).toEqual([name]);
	});

	it('import_csv refuses a spreadsheet it cannot read, in one line', () => {
		expect(refusal('import_csv', { csv: 'a;b\n' }).message).toBe(
			'the CSV has neither a label nor an amount column'
		);
		expect(existsSync(path)).toBe(false);
	});
});
