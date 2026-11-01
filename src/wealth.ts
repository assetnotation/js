/**
 * Keeping a document up to date, one operation at a time: a holding created or
 * changed, a valuation added, a spreadsheet merged in, and the net worth the
 * result adds up to. Every operation takes a document and returns a new one;
 * none of them touches a file, judges validity or reads the clock, so each can
 * be tested on a literal and the writer can validate before anything lands.
 *
 * Amounts are decimal strings all the way through and are summed exactly.
 */

import { csvColumns, fromCsv, type FromCsvOptions } from './csv.js';
import { entities, latestValuation, text, type Entity } from './document.js';
import { isDecimal, negateDecimal, sumDecimals } from './decimal.js';
import { supportedVersions, type AssetNotationDocument } from './validate.js';

/** Top-level keys in the order the specification lists them, so a rewritten
 *  file reads like the examples and diffs only where it changed. */
const KEY_ORDER = [
	'assetnotation',
	'generatedAt',
	'generator',
	'baseCurrency',
	'subjects',
	'institutions',
	'holdings',
	'instruments',
	'valuations',
	'transactions',
	'ownership',
	'extensions'
];

/** A valid document with nothing in it, declaring the newest schema shipped. */
export function emptyDocument(generatedAt: string): AssetNotationDocument {
	return {
		assetnotation: supportedVersions().at(-1),
		generatedAt,
		generator: { name: 'asset-notation', version: 'js' },
		holdings: []
	};
}

/** The same document, keys in specification order, stamped as generated now. */
export function normalize(doc: AssetNotationDocument, generatedAt: string): AssetNotationDocument {
	const stamped: AssetNotationDocument = { ...doc, generatedAt };
	const ordered: AssetNotationDocument = {};
	for (const key of KEY_ORDER) if (key in stamped) ordered[key] = stamped[key];
	for (const key of Object.keys(stamped)) if (!(key in ordered)) ordered[key] = stamped[key];
	return ordered;
}

/** The first `<prefix><n>` not yet used in the collection: ids stay short and
 *  stable, and a deleted entity's number is never handed out again within one
 *  document because `n` starts past the highest number present. */
export function nextId(doc: AssetNotationDocument, collection: string, prefix: string): string {
	const taken = new Set(entities(doc, collection).map((e) => String(e.id)));
	// BigInt, because an imported id past 2^53 would stop a Number from moving.
	let highest = 0n;
	for (const id of taken) {
		const m = new RegExp(String.raw`^${prefix}(\d+)$`).exec(id);
		if (m && BigInt(m[1]) > highest) highest = BigInt(m[1]);
	}
	let next = highest + 1n;
	while (taken.has(`${prefix}${next}`)) next += 1n;
	return `${prefix}${next}`;
}

export interface HoldingInput {
	/** The id to create or update. Absent, a fresh `h<n>` is minted. */
	id?: string;
	label?: string;
	kind?: string;
	nature?: 'asset' | 'liability';
	currency?: string;
	/** The NAME of the institution; it is matched or created in `institutions`.
	 *  `null` removes the link. */
	institution?: string | null;
	/** `null` removes the link to the parent holding. */
	parentId?: string | null;
	/** `null` removes the link to the instrument. */
	instrumentId?: string | null;
	quantity?: string;
	attributes?: Record<string, unknown>;
	openedAt?: string;
	closedAt?: string;
}

/** The institution id for a name, creating the entry when no institution of
 *  that name exists. Matching is on the name people type, never on an id. */
function institutionId(
	doc: AssetNotationDocument,
	name: string
): { doc: AssetNotationDocument; id: string } {
	const existing = entities(doc, 'institutions').find((i) => i.name === name);
	if (existing) return { doc, id: String(existing.id) };
	const id = nextId(doc, 'institutions', 'i');
	return { doc: { ...doc, institutions: [...entities(doc, 'institutions'), { id, name }] }, id };
}

/**
 * Create a holding, or change the fields given on the one with that id.
 * Fields absent from the input are kept as they were, so an update never
 * erases what it did not mention. A new holding defaults to an asset of kind
 * `other`, which is what a line in a spreadsheet of balances is.
 */
export function upsertHolding(
	doc: AssetNotationDocument,
	input: HoldingInput
): { doc: AssetNotationDocument; holding: Entity } {
	const { institution, ...fields } = input;
	let next = doc;
	const holdings = entities(doc, 'holdings');
	const index = input.id === undefined ? -1 : holdings.findIndex((h) => h.id === input.id);
	const base: Entity =
		index === -1
			? { id: input.id ?? nextId(doc, 'holdings', 'h'), kind: 'other', nature: 'asset' }
			: holdings[index];

	const holding: Entity = { ...base };
	for (const [key, value] of Object.entries(fields)) {
		if (value === null) delete holding[key];
		else if (value !== undefined) holding[key] = value;
	}
	if (institution === null) delete holding.institutionId;
	else if (institution !== undefined) {
		const found = institutionId(next, institution);
		next = found.doc;
		holding.institutionId = found.id;
	}

	const list = [...holdings];
	if (index === -1) list.push(holding);
	else list[index] = holding;
	return { doc: { ...next, holdings: list }, holding };
}

export interface ValuationInput {
	holdingId: string;
	/** `YYYY-MM-DD`, or an RFC 3339 timestamp. */
	asOf: string;
	/** A decimal string: `"4210.55"`, never a number. */
	amount: string;
	currency: string;
	source?: string;
	confidence?: number;
	quantity?: string;
}

/** Add what a holding was worth on a date. Never replaces an earlier valuation:
 *  the history is the point of the format. */
export function addValuation(
	doc: AssetNotationDocument,
	input: ValuationInput
): { doc: AssetNotationDocument; valuation: Entity } {
	const valuation: Entity = {
		id: nextId(doc, 'valuations', 'v'),
		holdingId: input.holdingId,
		asOf: input.asOf,
		value: { amount: input.amount, currency: input.currency }
	};
	if (input.quantity !== undefined) valuation.quantity = input.quantity;
	if (input.source !== undefined) valuation.source = input.source;
	if (input.confidence !== undefined) valuation.confidence = input.confidence;
	return { doc: { ...doc, valuations: [...entities(doc, 'valuations'), valuation] }, valuation };
}

export interface NetWorth {
	/** Assets minus liabilities, one line per currency, exact. */
	byCurrency: { currency: string; assets: string; liabilities: string; net: string }[];
	/** The date of the oldest valuation that entered the total, or null when none did. */
	oldestAsOf: string | null;
	/** Holdings that counted for nothing because they have no valuation. */
	unvaluedHoldingIds: string[];
	/** Holdings counted, by their latest valuation. */
	valuedHoldings: number;
}

/**
 * What the document adds up to, from the LATEST valuation of each holding.
 * One line per currency, because converting between them is a judgement call
 * this function refuses to make silently. Containers whose children are
 * valued are counted through their children: a parent with a valuation of its
 * own is counted too, so a document should value one or the other.
 */
export function netWorth(doc: AssetNotationDocument): NetWorth {
	const assets = new Map<string, string[]>();
	const liabilities = new Map<string, string[]>();
	const unvaluedHoldingIds: string[] = [];
	let oldest: Entity | undefined;
	let valuedHoldings = 0;

	for (const h of entities(doc, 'holdings')) {
		const v = latestValuation(doc, h.id);
		const value = v?.value;
		const amount =
			typeof value === 'object' && value !== null ? (value as Entity).amount : undefined;
		if (v === undefined || !isDecimal(amount)) {
			unvaluedHoldingIds.push(String(h.id));
			continue;
		}
		valuedHoldings++;
		const currency =
			text((value as Entity).currency) ?? text(h.currency) ?? text(doc.baseCurrency) ?? '';
		const bucket = h.nature === 'liability' ? liabilities : assets;
		bucket.set(currency, [...(bucket.get(currency) ?? []), amount]);
		if (oldest === undefined || Date.parse(String(v.asOf)) < Date.parse(String(oldest.asOf)))
			oldest = v;
	}

	const currencies = [...new Set([...assets.keys(), ...liabilities.keys()])].sort((a, b) =>
		a.localeCompare(b)
	);
	return {
		byCurrency: currencies.map((currency) => {
			const a = sumDecimals(assets.get(currency) ?? ['0']);
			const l = sumDecimals(liabilities.get(currency) ?? ['0']);
			return { currency, assets: a, liabilities: l, net: sumDecimals([a, negateDecimal(l)]) };
		}),
		oldestAsOf: oldest === undefined ? null : String(oldest.asOf),
		unvaluedHoldingIds,
		valuedHoldings
	};
}

/** A holding as a reader wants to see it: with its institution's name and
 *  what it was last worth, instead of ids to chase. */
export function listHoldings(doc: AssetNotationDocument): Entity[] {
	const names = new Map(entities(doc, 'institutions').map((i) => [i.id, i.name]));
	return entities(doc, 'holdings').map((h) => {
		const v = latestValuation(doc, h.id);
		return {
			...h,
			institution: names.get(h.institutionId) ?? null,
			latestValuation:
				v === undefined ? null : { asOf: v.asOf, value: v.value, source: v.source ?? null }
		};
	});
}

/** The fields `fromCsv` fills with a default when the sheet has no such column. */
const DEFAULTED_FIELDS = ['kind', 'nature', 'currency'] as const;

/**
 * Merge a spreadsheet into a document. A row lands on the holding with the
 * same id when the labels agree or the row has none; else on the holding with
 * the same label; else it becomes a new holding, under its own id when that id
 * is free, otherwise under a fresh one. Ids a converter minted (`h1`, `h2`)
 * therefore never overwrite someone's existing `h1` by coincidence. Every
 * valuation of the spreadsheet is added, re-numbered, to the matched holding;
 * institutions are matched by name.
 */
export function mergeCsv(
	doc: AssetNotationDocument,
	csv: string,
	options: FromCsvOptions
): { doc: AssetNotationDocument; holdingIds: string[]; valuations: number } {
	// Read with the ISO code for "no currency" as the base: a row that names
	// none, by column or by sign, then says so, and takes the currency of the
	// holding it lands on instead of the converter's EUR.
	const imported = fromCsv(csv, { ...options, baseCurrency: UNSTATED });
	// XXX is also a currency a row may STATE. Read once more under another
	// base: a currency that follows the base was unstated, one that stays XXX
	// was written in the sheet and is kept.
	const probe = fromCsv(csv, { ...options, baseCurrency: PROBE });
	const stated = (probed: Entity | undefined): boolean => probed?.currency === UNSTATED;
	const probedHoldings = entities(probe, 'holdings');
	const probedValues = entities(probe, 'valuations').map((v) => v.value as Entity);
	refuseAmbiguousIds(imported);
	const fallback = options.baseCurrency ?? text(doc.baseCurrency) ?? 'EUR';
	const columns = new Set(csvColumns(csv, options.delimiter));
	const institutionNames = new Map(
		entities(imported, 'institutions').map((i) => [i.id, String(i.name)])
	);
	const holdingIds = new Map<string, string>();
	let next = doc;

	for (const [index, h] of entities(imported, 'holdings').entries()) {
		const { institutionId: importedInstitution, ...fields } = h;
		const institution = institutionNames.get(importedInstitution);
		// fromCsv mints `h<row>` for a row whose id cell is empty.
		const idGiven = columns.has('id') && h.id !== `h${String(index + 1)}`;
		const id = targetHoldingId(next, h, institution, idGiven);
		// On a holding that exists, a column the sheet does not have says nothing:
		// the converter's defaults (an `other` asset in EUR) must not turn a debt
		// into an asset.
		if (entities(next, 'holdings').some((existing) => existing.id === id)) {
			for (const field of DEFAULTED_FIELDS) if (!columns.has(field)) delete fields[field];
		}
		if (fields.currency === UNSTATED && !stated(probedHoldings[index])) fields.currency = fallback;
		const input: HoldingInput = { ...(fields as HoldingInput), id, institution };
		const result = upsertHolding(next, input);
		next = result.doc;
		holdingIds.set(String(h.id), String(result.holding.id));
	}

	let valuations = 0;
	for (const [index, v] of entities(imported, 'valuations').entries()) {
		const value = v.value as Entity;
		const holdingId = holdingIds.get(String(v.holdingId)) ?? String(v.holdingId);
		const holding = entities(next, 'holdings').find((h) => h.id === holdingId);
		const result = addValuation(next, {
			holdingId,
			asOf: String(v.asOf),
			amount: String(value.amount),
			currency:
				value.currency === UNSTATED && !stated(probedValues[index])
					? (text(holding?.currency) ?? fallback)
					: String(value.currency),
			source: text(v.source)
		});
		next = result.doc;
		valuations++;
	}
	return { doc: next, holdingIds: [...new Set(holdingIds.values())], valuations };
}

/** ISO 4217 for "no currency": what a row that names none is read as. */
const UNSTATED = 'XXX';
/** A second base, only to tell a stated XXX from an unstated one. */
const PROBE = 'XTS';

/**
 * Two rows may share an id when they are the same holding (its history, one
 * row per date); under two labels or two institutions, the id says nothing
 * about which holding a valuation belongs to, and choosing would misfile money.
 */
function refuseAmbiguousIds(imported: AssetNotationDocument): void {
	const seen = new Map<string, Entity>();
	for (const h of entities(imported, 'holdings')) {
		const first = seen.get(String(h.id));
		if (first === undefined) seen.set(String(h.id), h);
		else if (first.label !== h.label || first.institutionId !== h.institutionId)
			throw new Error(
				`asset-notation: the CSV gives the id "${String(h.id)}" to two different holdings`
			);
	}
}

function targetHoldingId(
	doc: AssetNotationDocument,
	imported: Entity,
	institution: string | undefined,
	idGiven: boolean
): string {
	const holdings = entities(doc, 'holdings');
	const names = new Map(entities(doc, 'institutions').map((i) => [i.id, String(i.name)]));
	// Two banks may each hold an account called "Epargne": a label matches only
	// within the same institution, when both sides name one.
	const sameInstitution = (h: Entity): boolean => {
		const name = names.get(h.institutionId);
		return institution === undefined || name === undefined || name === institution;
	};
	const sameId = holdings.find((h) => h.id === imported.id);
	if (
		sameId &&
		(imported.label === undefined || sameId.label === imported.label) &&
		sameInstitution(sameId)
	)
		return String(sameId.id);
	// An id the sheet WROTE names one holding; under another label it is not a
	// coincidence of minted ids but a contradiction, and a guess would misfile money.
	if (sameId && idGiven)
		throw new Error(
			`asset-notation: the CSV row with id "${String(imported.id)}" names another holding than "${String(sameId.label)}"`
		);
	const sameLabel =
		imported.label === undefined
			? []
			: holdings.filter((h) => h.label === imported.label && sameInstitution(h));
	if (sameLabel.length > 1)
		throw new Error(
			`asset-notation: ${sameLabel.length} holdings are labelled "${String(imported.label)}"; give the row an id or an institution`
		);
	if (sameLabel.length === 1) return String(sameLabel[0].id);
	return sameId ? nextId(doc, 'holdings', 'h') : String(imported.id);
}
