/**
 * The validator, judged against the specification's own examples: if this
 * library and the spec repository disagree about what is valid, the library is
 * wrong by definition.
 *
 * The subtlety worth protecting is the difference between an ERROR and a NOTE.
 * A duplicate id is a broken document. A reference pointing at something the
 * document does not contain is NOT: any subset of a valid document is valid, so
 * a statement covering three accounts out of twelve, naming an institution it
 * does not describe, is a legitimate partial disclosure. Turning that into an
 * error would forbid exactly the sharing the format exists for.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validate, supportedVersions } from './validate.js';

const EXAMPLES = join(import.meta.dirname, '..', 'examples');

describe('the bundled schemas', () => {
	it('ships every published version, so an older document still gets judged', () => {
		const versions = supportedVersions();
		expect(versions.length).toBeGreaterThanOrEqual(3);
		expect(versions).toContain('0.3.0');
	});
});

describe('agreement with the specification examples', () => {
	const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'));

	it('finds the examples at all', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it.each(files)('accepts %s', (file) => {
		const doc: unknown = JSON.parse(readFileSync(join(EXAMPLES, file), 'utf8'));
		const result = validate(doc);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});
});

describe('what makes a document invalid', () => {
	it('refuses a document that declares no version', () => {
		const r = validate({ generatedAt: '2026-08-01T00:00:00Z', holdings: [] });
		expect(r.valid).toBe(false);
		expect(r.errors.join(' ')).toContain('no "assetnotation" version');
	});

	it('refuses a version it has no schema for, and says which it has', () => {
		const r = validate({
			assetnotation: '9.9.9',
			generatedAt: '2026-08-01T00:00:00Z',
			holdings: []
		});
		expect(r.valid).toBe(false);
		expect(r.errors.join(' ')).toContain('0.3.0');
	});

	it('refuses anything that is not a JSON object', () => {
		for (const bad of [null, [], 'x', 42]) expect(validate(bad).valid).toBe(false);
	});

	it('refuses an id used twice inside one collection', () => {
		const r = validate({
			assetnotation: '0.3.0',
			generatedAt: '2026-08-01T00:00:00Z',
			holdings: [
				{ id: 'h1', kind: 'checking', nature: 'asset' },
				{ id: 'h1', kind: 'savings', nature: 'asset' }
			]
		});
		expect(r.valid).toBe(false);
		expect(r.errors.join(' ')).toContain('duplicate id "h1"');
	});
});

describe('partial disclosure stays valid', () => {
	it('reports an unresolved reference as a note, and stays valid', () => {
		// Three accounts out of twelve, naming a bank the file does not describe:
		// a normal statement, not a broken document.
		const r = validate({
			assetnotation: '0.3.0',
			generatedAt: '2026-08-01T00:00:00Z',
			holdings: [{ id: 'h1', kind: 'checking', nature: 'asset', institutionId: 'i-absent' }],
			valuations: [
				{
					id: 'v1',
					holdingId: 'h-absent',
					asOf: '2026-06-24',
					value: { amount: '1.00', currency: 'EUR' }
				}
			]
		});
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
		expect(r.notes).toHaveLength(2);
		expect(r.notes.join(' ')).toContain('partial disclosure');
	});

	it('never throws on a malformed document: reporting is the job', () => {
		expect(() => validate({ assetnotation: '0.3.0', holdings: 'not an array' })).not.toThrow();
	});
});
