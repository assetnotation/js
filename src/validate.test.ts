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

	it('lists them oldest first, in numeric order', () => {
		const versions = supportedVersions();
		const numeric = versions.map((v) => v.split('.').map(Number));
		for (let i = 1; i < numeric.length; i++) {
			const [a, b] = [numeric[i - 1], numeric[i]];
			expect(a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])).toBe(true);
		}
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

describe('what the document is told without being refused', () => {
	const doc = (body: Record<string, unknown>): Record<string, unknown> => ({
		assetnotation: '0.3.0',
		generatedAt: '2026-08-01T00:00:00Z',
		holdings: [{ id: 'h1', kind: 'other', nature: 'asset' }],
		...body
	});

	it('names a chain of parents that comes back on itself', () => {
		// The specification counts a container through its children; a loop
		// never ends. Noted once, from its own start, not once per member.
		const result = validate(
			doc({
				holdings: [
					{ id: 'h1', kind: 'brokerage', nature: 'asset', parentId: 'h2' },
					{ id: 'h2', kind: 'brokerage', nature: 'asset', parentId: 'h1' },
					{ id: 'h3', kind: 'brokerage', nature: 'asset', parentId: 'h1' }
				]
			})
		);
		expect(result.valid).toBe(true);
		expect(result.notes).toEqual([
			'holding "h1".parentId forms a cycle (h1 -> h2 -> h1)',
			'holding "h2".parentId forms a cycle (h2 -> h1 -> h2)'
		]);
	});

	it('names a holding owned more than once over, exactly and never by a float', () => {
		const result = validate(
			doc({
				subjects: [
					{ id: 's1', type: 'person' },
					{ id: 's2', type: 'person' }
				],
				ownership: [
					{ subjectId: 's1', holdingId: 'h1', share: '0.7' },
					{ subjectId: 's2', holdingId: 'h1', share: '0.30000001' }
				]
			})
		);
		expect(result.valid).toBe(true);
		expect(result.notes).toEqual(['ownership of holding "h1" sums to 0.7 + 0.30000001, above 1']);

		const whole = validate(
			doc({
				subjects: [
					{ id: 's1', type: 'person' },
					{ id: 's2', type: 'person' }
				],
				ownership: [
					{ subjectId: 's1', holdingId: 'h1', share: '0.7' },
					{ subjectId: 's2', holdingId: 'h1', share: '0.3' }
				]
			})
		);
		expect(whole.notes).toEqual([]);
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

describe('a malformed entry in a collection', () => {
	it.each([
		['a null holding', { holdings: [null] }],
		['a null link', { holdings: [{ id: 'h1', links: [null] }] }]
	])('is reported, never thrown: %s', (_, body) => {
		const result = validate({
			assetnotation: '0.3.0',
			generatedAt: '2026-08-01T00:00:00Z',
			...body
		});
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});
