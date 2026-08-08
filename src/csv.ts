/**
 * The bridge between an Asset Notation document and the spreadsheet people
 * already keep.
 *
 * One row is one holding and what it was last worth. That is the shape everyone
 * already has - a line per account, a label, a balance, a date - and meeting it
 * is the whole point: a format nobody can get their existing numbers into is a
 * format nobody starts using.
 *
 * Two details decide whether this works outside an English-speaking office, and
 * both are handled rather than documented away. A spreadsheet saved from a
 * French, German or Spanish Excel separates its columns with a SEMICOLON and
 * writes decimals with a COMMA, because the comma is already taken. Reading such
 * a file as comma-separated turns every amount into two broken columns. So the
 * delimiter is detected from the text, and an amount is read against the
 * delimiter that was found.
 */

import type { AssetNotationDocument } from './validate.js';

/** Columns, in the order they are written. `institution` carries a NAME, not an
 *  id: a spreadsheet has "Crédit Mutuel" in it, never "i1". */
export const COLUMNS = [
	'id',
	'label',
	'kind',
	'nature',
	'currency',
	'institution',
	'amount',
	'asOf',
	'source'
] as const;

export interface CsvOptions {
	/** Column separator. Defaults to ';' on write (what a European spreadsheet
	 *  opens without a wizard) and to whichever is detected on read. */
	delimiter?: ',' | ';' | '\t';
}

/** Split one CSV line, honouring quotes: a label may legitimately contain the
 *  delimiter, a quote, or both. */
function splitLine(line: string, delimiter: string): string[] {
	const out: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					field += '"'; // an escaped quote inside a quoted field
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"') quoted = true;
		else if (c === delimiter) {
			out.push(field);
			field = '';
		} else field += c;
	}
	out.push(field);
	return out;
}

function quote(value: string, delimiter: string): string {
	return /["\n\r]/.test(value) || value.includes(delimiter)
		? `"${value.replaceAll('"', '""')}"`
		: value;
}

/** The delimiter that carves the header into the most columns. Counting on the
 *  header alone is deliberate: a label containing a comma would otherwise vote
 *  for the wrong answer. */
function detectDelimiter(header: string): ',' | ';' | '\t' {
	const counts = ([';', ',', '\t'] as const).map((d) => [d, splitLine(header, d).length] as const);
	return counts.sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * An amount as the format wants it: a decimal STRING, so no float ever rounds
 * someone's balance. A comma is read as the decimal mark only when it cannot be
 * the column separator, and spaces - including the narrow no-break space French
 * spreadsheets use for thousands - are dropped.
 */
function amountOf(raw: string, delimiter: string): string {
	// \u00A0 (no-break) and \u202F (narrow no-break) are the spaces a spreadsheet
	// writes between thousands. Written as escapes on purpose: the characters
	// themselves are invisible in a diff, and a linter is right to refuse them.
	const cleaned = raw.replace(/[\s\u00A0\u202F]/g, '').trim();
	if (cleaned === '') return '';
	if (delimiter !== ',' && cleaned.includes(',') && !cleaned.includes('.')) {
		return cleaned.replace(',', '.');
	}
	// Both marks are present, so one groups thousands and the other is the
	// decimal point. Which is which is decided by POSITION, never by locale: the
	// rightmost of the two is always the decimal mark, because no notation puts a
	// thousands separator after it. "1,234.56" and "1.234,56" are the same
	// number, and reading the second as the first divides a balance by a thousand
	// without anything failing.
	const lastComma = cleaned.lastIndexOf(',');
	const lastDot = cleaned.lastIndexOf('.');
	if (lastComma !== -1 && lastDot !== -1) {
		return lastComma > lastDot
			? cleaned.replaceAll('.', '').replace(',', '.')
			: cleaned.replaceAll(',', '');
	}
	return cleaned;
}

/** The most recent valuation of a holding, or undefined when it has none. */
function latestValuation(
	doc: AssetNotationDocument,
	holdingId: unknown
): Record<string, unknown> | undefined {
	const valuations = Array.isArray(doc.valuations)
		? (doc.valuations as Record<string, unknown>[])
		: [];
	return valuations
		.filter((v) => v.holdingId === holdingId)
		.sort((a, b) => String(a.asOf ?? '').localeCompare(String(b.asOf ?? '')))
		.pop();
}

/** Write the document as a spreadsheet: one row per holding, with what it was
 *  last worth. Holdings with no valuation keep their row, with empty amount and
 *  date - dropping them would silently lose an account someone declared. */
export function toCsv(doc: AssetNotationDocument, options: CsvOptions = {}): string {
	const delimiter = options.delimiter ?? ';';
	const institutions = new Map<string, string>();
	for (const raw of Array.isArray(doc.institutions) ? doc.institutions : []) {
		const inst = raw as Record<string, unknown>;
		if (typeof inst.id === 'string') institutions.set(inst.id, String(inst.name ?? inst.id));
	}

	const lines = [COLUMNS.join(delimiter)];
	for (const raw of Array.isArray(doc.holdings) ? doc.holdings : []) {
		const h = raw as Record<string, unknown>;
		const v = latestValuation(doc, h.id);
		const value = (v?.value ?? {}) as Record<string, unknown>;
		const row = [
			String(h.id ?? ''),
			String(h.label ?? ''),
			String(h.kind ?? ''),
			String(h.nature ?? ''),
			String(h.currency ?? value.currency ?? doc.baseCurrency ?? ''),
			institutions.get(String(h.institutionId ?? '')) ?? '',
			String(value.amount ?? ''),
			String(v?.asOf ?? ''),
			String(v?.source ?? '')
		];
		lines.push(row.map((f) => quote(f, delimiter)).join(delimiter));
	}
	return lines.join('\n') + '\n';
}

export interface FromCsvOptions extends CsvOptions {
	/** Stamped as the document's `generatedAt`. Given rather than read from the
	 *  clock so the same input always produces the same bytes, which is what
	 *  lets a converted file be diffed or committed. */
	generatedAt?: string;
	/** The version to declare. Defaults to the newest this build validates. */
	version?: string;
	baseCurrency?: string;
}

/**
 * Read a spreadsheet into a document. Rows missing a label AND an amount are
 * skipped, which is what the blank lines at the bottom of every real export
 * are; anything else is kept, because deciding a row is meaningless is the
 * user's call and not this function's.
 */
export function fromCsv(text: string, options: FromCsvOptions = {}): AssetNotationDocument {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
	if (lines.length === 0) throw new Error('asset-notation: the CSV is empty');

	const delimiter = options.delimiter ?? detectDelimiter(lines[0]);
	const header = splitLine(lines[0], delimiter).map((h) => h.trim().toLowerCase());
	const at = (row: string[], name: string): string => {
		const i = header.indexOf(name);
		return i === -1 ? '' : (row[i] ?? '').trim();
	};

	const holdings: Record<string, unknown>[] = [];
	const valuations: Record<string, unknown>[] = [];
	const institutions = new Map<string, string>();

	for (let i = 1; i < lines.length; i++) {
		const row = splitLine(lines[i], delimiter);
		const label = at(row, 'label');
		const amount = amountOf(at(row, 'amount'), delimiter);
		if (label === '' && amount === '') continue;

		const id = at(row, 'id') || `h${holdings.length + 1}`;
		const currency = at(row, 'currency').toUpperCase() || options.baseCurrency || 'EUR';
		const holding: Record<string, unknown> = {
			id,
			kind: at(row, 'kind') || 'other',
			// A row that does not say is an asset: that is what a spreadsheet of
			// balances is, and a wrong "liability" would flip a net worth.
			nature: at(row, 'nature').toLowerCase() === 'liability' ? 'liability' : 'asset',
			currency
		};
		if (label !== '') holding.label = label;

		const name = at(row, 'institution');
		if (name !== '') {
			let instId = [...institutions].find(([, n]) => n === name)?.[0];
			if (!instId) {
				instId = `i${institutions.size + 1}`;
				institutions.set(instId, name);
			}
			holding.institutionId = instId;
		}
		holdings.push(holding);

		if (amount !== '') {
			const valuation: Record<string, unknown> = {
				id: `v${valuations.length + 1}`,
				holdingId: id,
				asOf: at(row, 'asOf') || at(row, 'asof') || (options.generatedAt ?? '').slice(0, 10),
				value: { amount, currency }
			};
			const source = at(row, 'source');
			if (source !== '') valuation.source = source;
			valuations.push(valuation);
		}
	}

	const doc: AssetNotationDocument = {
		assetnotation: options.version ?? '0.3.0',
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		generator: { name: 'asset-notation', version: 'js' }
	};
	if (options.baseCurrency) doc.baseCurrency = options.baseCurrency;
	if (institutions.size > 0) {
		doc.institutions = [...institutions].map(([id, name]) => ({ id, name }));
	}
	doc.holdings = holdings;
	if (valuations.length > 0) doc.valuations = valuations;
	return doc;
}
