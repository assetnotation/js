/**
 * Reading a document that may be malformed. These helpers answer rather than
 * throw on a missing or mistyped collection: judging the shape is the
 * validator's job, and everything else must still be able to look.
 */

import type { AssetNotationDocument } from './validate.js';

export type Entity = Record<string, unknown>;

export const isObject = (v: unknown): v is Entity =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** A field that should be text, as text; anything else is nothing. */
export const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The objects of a top-level collection; empty when it is absent or not a list. */
export function entities(doc: AssetNotationDocument, name: string): Entity[] {
	const value = doc[name];
	return Array.isArray(value) ? value.filter(isObject) : [];
}

/** The instant a date names, so `2026-06-24T01:00:00+02:00` sorts before
 *  `2026-06-23T23:30:00Z` as it should; a text order said otherwise. A date
 *  alone is its UTC midnight; an unreadable one sorts first. */
export function instantOf(asOf: unknown): number {
	const t = Date.parse(typeof asOf === 'string' ? asOf : '');
	return Number.isNaN(t) ? -Infinity : t;
}

/**
 * The latest valuation of every holding, in one pass over the valuations: a
 * lookup per holding filtered the whole list each time, 180 million entries
 * read for a thousand holdings valued daily for six months. On a tie, the one
 * listed last wins, as the stable sort it replaces gave.
 */
export function latestValuations(doc: AssetNotationDocument): Map<unknown, Entity> {
	const latest = new Map<unknown, Entity>();
	for (const v of entities(doc, 'valuations')) {
		const held = latest.get(v.holdingId);
		if (!held || instantOf(v.asOf) >= instantOf(held.asOf)) latest.set(v.holdingId, v);
	}
	return latest;
}
