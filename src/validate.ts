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

function load(): Map<string, { version: string; validate: ValidateFunction }> {
	if (validators.size > 0) return validators;
	const root = schemaRoot();
	for (const version of readdirSync(root).sort()) {
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

/** Every schema version this build can judge a document against. */
export function supportedVersions(): string[] {
	return [...load().values()].map((v) => v.version);
}

/** Any top-level array of entities. Takes a plain name rather than a
 *  `Collection`: `ownership` is walked for its references but carries no id of
 *  its own, so it is not one of the collections whose ids must be unique. */
function list(doc: AssetNotationDocument, name: string): Record<string, unknown>[] {
	const value = doc[name];
	return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function integrity(doc: AssetNotationDocument): { errors: string[]; notes: string[] } {
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
			for (const raw of h.links) {
				const link = raw as Record<string, unknown>;
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
	return { errors, notes };
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
	const entry = load().get(declared.split('.').slice(0, 2).join('.'));
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
	const rules = integrity(document);
	errors.push(...rules.errors);

	return { valid: errors.length === 0, schemaVersion: entry.version, errors, notes: rules.notes };
}
