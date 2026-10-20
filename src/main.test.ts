/**
 * The command line, run in-process. What is protected here is the contract a
 * shell script relies on: the exit code, and one diagnostic line on stderr
 * for a bad input rather than a stack trace.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './main.js';

const dir = mkdtempSync(join(tmpdir(), 'asset-notation-'));

function file(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

function cli(...argv: string[]): { code: number; out: string; err: string } {
	let out = '';
	let err = '';
	const code = run(argv, {
		stdout: { write: (t: string) => (out += t) },
		stderr: { write: (t: string) => (err += t) }
	});
	// Every command but `mcp` answers at once; a promise here would be a regression.
	if (typeof code !== 'number') throw new Error('the command did not answer at once');
	return { code, out, err };
}

describe('the command line', () => {
	it('validates a document: 0 and a verdict on stderr', () => {
		const path = file(
			'ok.json',
			'{"assetnotation":"0.3.0","generatedAt":"2026-08-01T00:00:00Z","holdings":[]}'
		);
		const r = cli('validate', path);
		expect(r.code).toBe(0);
		expect(r.err).toBe('valid  Asset Notation 0.3.0\n');
	});

	it('refuses an invalid document with 1 and says why', () => {
		const path = file('bad.json', '{"assetnotation":"0.3.0","holdings":[]}');
		const r = cli('validate', path);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/^error {2}\/ must have required property 'generatedAt'/);
	});

	it('reports a file that is not JSON as one line, not a stack trace', () => {
		const path = file('not.json', '{not json');
		const r = cli('validate', path);
		expect(r.code).toBe(1);
		expect(r.err).toMatch(/^error {2}.*not\.json is not JSON: /);
		expect(r.err.split('\n').filter(Boolean)).toHaveLength(1);
	});

	it('reports a spreadsheet it cannot read as one line', () => {
		const r = cli('from-csv', file('empty.csv', '\n'));
		expect(r.code).toBe(1);
		expect(r.err).toBe('error  the CSV is empty\n');
		expect(r.out).toBe('');
	});

	it('converts a spreadsheet to stdout and judges the result', () => {
		const r = cli('from-csv', file('a.csv', 'label;amount;asOf\nLivret;1 234,56;24/06/2026\n'));
		expect(r.code).toBe(0);
		expect(r.err).toBe('');
		const doc = JSON.parse(r.out) as { valuations: { asOf: string; value: { amount: string } }[] };
		expect(doc.valuations[0].value.amount).toBe('1234.56');
		expect(doc.valuations[0].asOf).toBe('2026-06-24');
	});

	it('refuses to export an invalid document: 1, the reasons, and no CSV', () => {
		const path = file(
			'bad-holdings.json',
			'{"assetnotation":"0.3.0","generatedAt":"2026-08-01T00:00:00Z","holdings":{}}'
		);
		const r = cli('to-csv', path);
		expect(r.code).toBe(1);
		expect(r.out).toBe('');
		expect(r.err).toMatch(/^error /);
	});

	it('answers 2 and the usage when the command is wrong', () => {
		expect(cli().code).toBe(2);
		expect(cli('frobnicate', 'x').code).toBe(2);
		expect(cli('validate', join(dir, 'missing.json')).code).toBe(2);
		expect(cli().err).toMatch(/^asset-notation <command> <file>/);
	});

	it('answers 2 and the usage for mcp without a file, without starting a server', () => {
		const r = cli('mcp');
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/mcp {6}<file\.json>/);
		expect(r.out).toBe('');
	});
});
