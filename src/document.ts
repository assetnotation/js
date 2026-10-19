/**
 * Reading a document that may be malformed. These helpers answer rather than
 * throw on a missing or mistyped collection: judging the shape is the
 * validator's job, and everything else must still be able to look.
 */

import type { AssetNotationDocument } from './validate.js';

export type Entity = Record<string, unknown>;

export const isObject = (v: unknown): v is Entity =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** The objects of a top-level collection; empty when it is absent or not a list. */
export function entities(doc: AssetNotationDocument, name: string): Entity[] {
	const value = doc[name];
	return Array.isArray(value) ? value.filter(isObject) : [];
}

/** The instant a date names, so `2026-06-24T01:00:00+02:00` sorts before
 *  `2026-06-23T23:30:00Z` as it should; a text order said otherwise. A date
 *  alone is its UTC midnight; an unreadable one sorts first. */
export function instantOf(asOf: unknown): number {
	const t = Date.parse(String(asOf ?? ''));
	return Number.isNaN(t) ? -Infinity : t;
}

/** The most recent valuation of a holding, or undefined when it has none. */
export function latestValuation(
	doc: AssetNotationDocument,
	holdingId: unknown
): Entity | undefined {
	return entities(doc, 'valuations')
		.filter((v) => v.holdingId === holdingId)
		.sort((a, b) => instantOf(a.asOf) - instantOf(b.asOf))
		.pop();
}
