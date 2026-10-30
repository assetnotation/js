/**
 * Validate an Asset Notation document.
 *
 * Two layers, because one of them cannot be a JSON Schema. The schema answers
 * for shape, and is chosen by the version the document itself declares, matched
 * on major.minor - a document says what it is, and is judged against that.
 *
 * The second layer is the document-level rules a schema has no way to express:
 * an id used twice inside one collection is an error, and a reference that
 * points at nothing is a NOTE rather than an error. That second rule is
 * deliberate and it is the interesting one: any subset of a valid document is
 * itself valid, so a statement listing three accounts out of twelve, or one that
 * names an institution it does not describe, is a legitimate partial
 * disclosure - not a broken file. Reporting it as an error would make the format
 * unusable for exactly the sharing it exists to allow.
 */

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Collections whose members carry an `id` unique within that collection. */
const COLLECTIONS = [
	'subjects',
	'institutions',
	'holdings',
	'instruments',
	'valuations',
	'transactions'
] as const;

type Collection = (typeof COLLECTIONS)[number];

/** A document, kept deliberately loose: validating is this module's job, and a
 *  strict type here would refuse the malformed input it exists to report on. */
export type AssetNotationDocument = Record<string, unknown> & { assetnotation?: unknown };

export interface ValidationResult {
	/** Shape is valid AND no document-level error. Notes do not affect it. */
	valid: boolean;
	/** The schema version the document was judged against, or null when none matched. */
	schemaVersion: string | null;
	/** Anything that makes the document invalid, in reading order. */
	errors: string[];
	/** True observations that are not faults, chiefly unresolved references. */
	notes: string[];
}

const here = dirname(fileURLToPath(import.meta.url));

/** Schemas ship with the package. A validator that reaches the network to learn
 *  what is valid is useless in the places this format is meant to travel. */
function schemaRoot(): string {
	for (const candidate of [join(here, '..', 'schema'), join(here, '..', '..', 'schema')]) {
		try {
			readdirSync(candidate);
			return candidate;
		} catch {
			/* try the next one: the layout differs between the sources and the build */
		}
	}
	throw new Error('asset-notation: bundled schemas not found');
}

const validators = new Map<string, { version: string; validate: ValidateFunction }>();

/** Numeric order of version folders, so "0.10.0" follows "0.9.0" and the last
 *  one is the newest. */
function byVersion(a: string, b: string): number {
	const [x, y] = [a, b].map((v) => v.split('.').map(Number));
	return x[0] - y[0] || x[1] - y[1] || (x[2] ?? 0) - (y[2] ?? 0);
}

function load(): Map<string, { version: string; validate: ValidateFunction }> {
	if (validators.size > 0) return validators;
	const root = schemaRoot();
	for (const version of readdirSync(root).sort(byVersion)) {
		const file = join(root, version, 'asset-notation.schema.json');
		const schema = JSON.parse(readFileSync(file, 'utf8')) as object;
		const ajv = new Ajv2020({ allErrors: true, strict: false });
		addFormats(ajv);
		validators.set(version.split('.').slice(0, 2).join('.'), {
			version,
			validate: ajv.compile(schema)
		});
	}
	return validators;
}

/** Every schema version this build can judge a document against, oldest first. */
export function supportedVersions(): string[] {
	return [...load().values()].map((v) => v.version);
}

/** Any top-level array of entities. Takes a plain name rather than a
 *  `Collection`: `ownership` is walked for its references but carries no id of
 *  its own, so it is not one of the collections whose ids must be unique. */
const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function list(doc: AssetNotationDocument, name: string): Record<string, unknown>[] {
	const value = doc[name];
	// A null or a scalar in a collection is the schema's error to report; the
	// checks below read fields, and must not throw instead of answering.
	return Array.isArray(value) ? value.filter(isObject) : [];
}

/** Whether a declared `major.minor` is at least `floor`: a rule a release adds
 *  judges the documents of that release on, never an archive written before. */
function atLeast(majorMinor: string, floor: string): boolean {
	const [a, b] = majorMinor.split('.').map(Number);
	const [c, d] = floor.split('.').map(Number);
	return a > c || (a === c && b >= d);
}

function integrity(
	doc: AssetNotationDocument,
	majorMinor: string
): { errors: string[]; notes: string[] } {
	const errors: string[] = [];
	const notes: string[] = [];
	const ids: Record<Collection, Set<string>> = {} as Record<Collection, Set<string>>;

	for (const name of COLLECTIONS) {
		const seen = new Set<string>();
		for (const entity of list(doc, name)) {
			const id = entity.id;
			if (typeof id !== 'string') continue; // shape is the schema's job, not this one's
			if (seen.has(id)) errors.push(`duplicate id "${id}" in ${name}`);
			seen.add(id);
		}
		ids[name] = seen;
	}

	const ref = (from: string, field: string, id: unknown, target: Collection): void => {
		if (typeof id === 'string' && !ids[target].has(id)) {
			notes.push(`${from}.${field} "${id}" does not resolve to ${target} (partial disclosure)`);
		}
	};

	for (const h of list(doc, 'holdings')) {
		const from = `holding ${String(h.id)}`;
		ref(from, 'parentId', h.parentId, 'holdings');
		ref(from, 'institutionId', h.institutionId, 'institutions');
		ref(from, 'instrumentId', h.instrumentId, 'instruments');
		if (Array.isArray(h.links)) {
			for (const link of h.links.filter(isObject)) {
				ref(from, `link[${String(link.rel)}].holdingId`, link.holdingId, 'holdings');
			}
		}
	}
	for (const v of list(doc, 'valuations')) {
		ref(`valuation ${String(v.id)}`, 'holdingId', v.holdingId, 'holdings');
	}
	for (const t of list(doc, 'transactions')) {
		const from = `transaction ${String(t.id)}`;
		ref(from, 'holdingId', t.holdingId, 'holdings');
		ref(from, 'counterpartHoldingId', t.counterpartHoldingId, 'holdings');
		ref(from, 'instrumentId', t.instrumentId, 'instruments');
	}
	for (const o of list(doc, 'ownership')) {
		ref('ownership', 'subjectId', o.subjectId, 'subjects');
		ref('ownership', 'holdingId', o.holdingId, 'holdings');
	}
	// Each rule judges the versions that state it, as the specification's own
	// validator does: an archive valid under 0.3.0 stays valid.
	if (atLeast(majorMinor, '0.4')) errors.push(...parentCycles(doc), ...ownershipOverlaps(doc));
	if (atLeast(majorMinor, '0.5')) errors.push(...negativeLiabilities(doc));
	notes.push(...overSharedHoldings(doc));
	return { errors, notes };
}

/** A liability valued below zero (specification section 5.3, since 0.5.0): the
 *  derivation subtracts a liability, so a negative outstanding would count the
 *  debt as an asset. A valuation whose holding is absent is not judged: its
 *  nature is unknown. */
function negativeLiabilities(doc: AssetNotationDocument): string[] {
	const liabilities = new Set(
		list(doc, 'holdings')
			.filter((h) => h.nature === 'liability')
			.map((h) => h.id)
	);
	return list(doc, 'valuations')
		.filter((v) => {
			const value = isObject(v.value) ? v.value : {};
			return (
				liabilities.has(v.holdingId) &&
				String(value.amount ?? '')
					.trim()
					.startsWith('-')
			);
		})
		.map(
			(v) =>
				`negative liability value: valuation "${String(v.id)}" of holding "${String(v.holdingId)}"`
		);
}

/** A holding whose chain of parents comes back to itself: an integrity error
 *  (specification section 4), since the derivation walks the chain and a loop
 *  has no root. */
function parentCycles(doc: AssetNotationDocument): string[] {
	const parentOf = new Map<string, string>();
	for (const h of list(doc, 'holdings')) {
		if (typeof h.id === 'string' && typeof h.parentId === 'string') parentOf.set(h.id, h.parentId);
	}
	const errors: string[] = [];
	for (const start of parentOf.keys()) {
		const chain = [start];
		for (let next = parentOf.get(start); next !== undefined; next = parentOf.get(next)) {
			if (next === start) {
				errors.push(`parent cycle: ${chain.join(' -> ')} -> ${start}`);
				break;
			}
			if (chain.includes(next)) break; // the loop is elsewhere, reported from its own start
			chain.push(next);
		}
	}
	return errors;
}

/** Two ownership rows of one subject on one holding whose intervals overlap
 *  (specification section 5.7). A calendar date compares as text: YYYY-MM-DD
 *  sorts as it dates. An absent `from` is since always, an absent `until` is
 *  still holding. */
function ownershipOverlaps(doc: AssetNotationDocument): string[] {
	const rows = new Map<string, Record<string, unknown>[]>();
	for (const o of list(doc, 'ownership')) {
		if (typeof o.subjectId !== 'string' || typeof o.holdingId !== 'string') continue;
		const key = `${o.subjectId}\u0000${o.holdingId}`;
		rows.set(key, [...(rows.get(key) ?? []), o]);
	}
	const bound = (v: unknown): string => (typeof v === 'string' ? v : '');
	const errors: string[] = [];
	for (const rowsOfOne of rows.values()) {
		const sorted = [...rowsOfOne].sort((a, b) => bound(a.from).localeCompare(bound(b.from)));
		for (let i = 1; i < sorted.length; i++) {
			const previous = sorted[i - 1];
			const current = sorted[i];
			if (previous.until === undefined || bound(current.from) < bound(previous.until)) {
				errors.push(
					`ownership of holding "${String(current.holdingId)}" by "${String(current.subjectId)}" overlaps: [${bound(previous.from)}, ${bound(previous.until)}) and [${bound(current.from)}, ${bound(current.until)})`
				);
			}
		}
	}
	return errors;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** The exact sum of decimal strings, scaled to integers on the longest
 *  fraction: no float ever rounds an ownership share. */
function sumOfDecimals(values: string[]): { total: bigint; scale: number } {
	const scale = Math.max(0, ...values.map((v) => v.split('.')[1]?.length ?? 0));
	const total = values.reduce((acc, v) => {
		const [whole, fraction = ''] = v.split('.');
		return acc + BigInt(whole + fraction.padEnd(scale, '0'));
	}, 0n);
	return { total, scale };
}

/** A holding whose ownership shares add up to more than the whole of it. The
 *  specification says they SHOULD sum to at most 1; a consumer would count
 *  the excess in a household total. */
function overSharedHoldings(doc: AssetNotationDocument): string[] {
	const sharesOf = new Map<string, string[]>();
	for (const o of list(doc, 'ownership')) {
		if (typeof o.holdingId !== 'string' || typeof o.share !== 'string' || !DECIMAL.test(o.share)) {
			continue; // shape is the schema's job
		}
		sharesOf.set(o.holdingId, [...(sharesOf.get(o.holdingId) ?? []), o.share]);
	}
	const notes: string[] = [];
	for (const [holdingId, shares] of sharesOf) {
		const { total, scale } = sumOfDecimals(shares);
		if (total > 10n ** BigInt(scale)) {
			notes.push(`ownership of holding "${holdingId}" sums to ${shares.join(' + ')}, above 1`);
		}
	}
	return notes;
}

/**
 * Judge a document. Never throws on a malformed one: reporting what is wrong is
 * the whole point, and a thrown error would force every caller to wrap it.
 */
export function validate(doc: unknown): ValidationResult {
	if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
		return { valid: false, schemaVersion: null, errors: ['not a JSON object'], notes: [] };
	}
	const document = doc as AssetNotationDocument;
	const declared = String(document.assetnotation ?? '');
	const majorMinor = declared.split('.').slice(0, 2).join('.');
	const entry = load().get(majorMinor);
	if (!entry) {
		return {
			valid: false,
			schemaVersion: null,
			errors: [
				declared === ''
					? 'no "assetnotation" version declared'
					: `no bundled schema for declared version "${declared}" (this build has ${supportedVersions().join(', ')})`
			],
			notes: []
		};
	}

	const errors: string[] = [];
	if (!entry.validate(document)) {
		for (const err of entry.validate.errors ?? []) {
			errors.push(`${err.instancePath || '/'} ${err.message ?? 'is invalid'}`);
		}
	}
	const rules = integrity(document, majorMinor);
	errors.push(...rules.errors);

	return { valid: errors.length === 0, schemaVersion: entry.version, errors, notes: rules.notes };
}
