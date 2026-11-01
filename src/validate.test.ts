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
		expect(versions).toContain('0.4.0');
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

describe('the document-level rules', () => {
	const doc = (body: Record<string, unknown>): Record<string, unknown> => ({
		assetnotation: '0.3.0',
		generatedAt: '2026-08-01T00:00:00Z',
		holdings: [{ id: 'h1', kind: 'other', nature: 'asset' }],
		...body
	});

	it('refuses a chain of parents that comes back on itself', () => {
		// The specification walks the chain to derive a total; a loop has no
		// root. An error since 0.4.0, reported from each member's own start.
		const result = validate(
			doc({
				assetnotation: '0.4.0',
				holdings: [
					{ id: 'h1', kind: 'brokerage', nature: 'asset', parentId: 'h2' },
					{ id: 'h2', kind: 'brokerage', nature: 'asset', parentId: 'h1' },
					{ id: 'h3', kind: 'brokerage', nature: 'asset', parentId: 'h1' }
				]
			})
		);
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(['parent cycle: h1 -> h2 -> h1', 'parent cycle: h2 -> h1 -> h2']);
	});

	it('walks a long chain of parents in linear time', () => {
		const holdings = Array.from({ length: 20000 }, (_, i) => ({
			id: `h${i}`,
			kind: 'brokerage',
			nature: 'asset',
			...(i > 0 ? { parentId: `h${i - 1}` } : {})
		}));
		const started = performance.now();
		const result = validate(doc({ assetnotation: '0.4.0', holdings }));
		expect(result.errors.filter((e) => e.startsWith('parent cycle'))).toEqual([]);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	it('names each holding of a loop once, from itself, and a self parent too', () => {
		const result = validate(
			doc({
				assetnotation: '0.4.0',
				holdings: [
					{ id: 'a', kind: 'brokerage', nature: 'asset', parentId: 'b' },
					{ id: 'b', kind: 'brokerage', nature: 'asset', parentId: 'c' },
					{ id: 'c', kind: 'brokerage', nature: 'asset', parentId: 'a' },
					{ id: 'd', kind: 'brokerage', nature: 'asset', parentId: 'd' },
					{ id: 'e', kind: 'brokerage', nature: 'asset', parentId: 'a' }
				]
			})
		);
		expect(result.errors.filter((e) => e.startsWith('parent cycle'))).toEqual([
			'parent cycle: a -> b -> c -> a',
			'parent cycle: b -> c -> a -> b',
			'parent cycle: c -> a -> b -> c',
			'parent cycle: d -> d'
		]);
	});

	it('refuses two ownership rows of one subject on one holding that overlap in time', () => {
		const subjects = [{ id: 's1', type: 'person' }];
		const overlapping = validate(
			doc({
				assetnotation: '0.4.0',
				subjects,
				ownership: [
					{ subjectId: 's1', holdingId: 'h1', share: '1', until: '2026-06-01' },
					{ subjectId: 's1', holdingId: 'h1', share: '0.5', from: '2026-01-01' }
				]
			})
		);
		expect(overlapping.valid).toBe(false);
		expect(overlapping.errors).toEqual([
			'ownership of holding "h1" by "s1" overlaps: [, 2026-06-01) and [2026-01-01, )'
		]);

		// Closed on the day the next one opens: history, not an overlap.
		const succession = validate(
			doc({
				assetnotation: '0.4.0',
				subjects,
				ownership: [
					{ subjectId: 's1', holdingId: 'h1', share: '1', until: '2026-01-01' },
					{ subjectId: 's1', holdingId: 'h1', share: '0.5', from: '2026-01-01' }
				]
			})
		);
		expect(succession.errors).toEqual([]);
	});

	it('adds up only the shares held at the same time', () => {
		const people = [
			{ id: 's1', type: 'person' },
			{ id: 's2', type: 'person' }
		];
		const succession = validate(
			doc({
				subjects: people,
				ownership: [
					{ subjectId: 's1', holdingId: 'h1', share: '1', until: '2024-01-01' },
					{ subjectId: 's2', holdingId: 'h1', share: '1', from: '2024-01-01' }
				]
			})
		);
		expect(succession.notes).toEqual([]);
		const together = validate(
			doc({
				subjects: people,
				ownership: [
					{ subjectId: 's1', holdingId: 'h1', share: '1', until: '2024-06-01' },
					{ subjectId: 's2', holdingId: 'h1', share: '0.5', from: '2024-01-01' }
				]
			})
		);
		expect(together.notes).toEqual(['ownership of holding "h1" sums to 1 + 0.5, above 1']);
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

/** The document-level invariants a conformance case may expect, and the
 *  prefix of the error each one raises here. */
const INVARIANTS: Record<string, string> = {
	'duplicate-id': 'duplicate id',
	'parent-cycle': 'parent cycle',
	'ownership-overlap': 'ownership of holding',
	'negative-liability': 'negative liability value'
};

interface ConformanceCase {
	name: string;
	valid: boolean;
	expect?: string;
	document: unknown;
}

describe('the conformance corpus of the specification', () => {
	const dir = join(import.meta.dirname, '..', 'conformance');
	const suites = readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.map((f) => ({
			file: f,
			cases: (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { cases: ConformanceCase[] }).cases
		}));

	it('is there, and large enough to mean something', () => {
		expect(suites.length).toBeGreaterThan(0);
		expect(suites.reduce((n, s) => n + s.cases.length, 0)).toBeGreaterThanOrEqual(45);
	});

	it.each(suites.flatMap((s) => s.cases.map((c) => [`${s.file}: ${c.name}`, c] as const)))(
		'reaches the stated verdict on %s',
		(_, c) => {
			const result = validate(c.document);
			if (c.valid) {
				expect(result.errors).toEqual([]);
				return;
			}
			expect(result.valid).toBe(false);
			const expected = c.expect ?? '';
			const prefix = expected in INVARIANTS ? INVARIANTS[expected] : `${expected || '/'} `;
			expect(result.errors.some((e) => e.startsWith(prefix))).toBe(true);
		}
	);
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
