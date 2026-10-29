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

import { supportedVersions, type AssetNotationDocument } from './validate.js';
import { latestValuation } from './document.js';

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

/** The records of a CSV text: a line break inside a quoted field belongs to the
 *  field, as `toCsv` writes it, and an unclosed quote is refused rather than
 *  read as the rest of the file. */
function records(text: string): string[] {
	const out: string[] = [];
	let start = 0;
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') quoted = !quoted;
		else if (c === '\n' && !quoted) {
			out.push(text.slice(start, i).replace(/\r$/, ''));
			start = i + 1;
		}
	}
	if (quoted) throw new Error('asset-notation: the CSV has an unclosed quote');
	out.push(text.slice(start).replace(/\r$/, ''));
	return out;
}

/** What a spreadsheet reads as a formula at the start of a cell (OWASP CSV injection). */
const FORMULA = /^[=+\-@\t\r]/;

/** A text cell a spreadsheet would run as a formula, kept as text by a leading apostrophe. */
function inert(value: string): string {
	return FORMULA.test(value) ? `'${value}` : value;
}

/** The text an `inert` cell carried, so an export reads back as it was. */
function revived(value: string): string {
	return value.startsWith("'") && FORMULA.test(value.slice(1)) ? value.slice(1) : value;
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

/** The currency signs a spreadsheet's currency format prints, and the one each
 *  can only mean. The yen sign is absent on purpose: it is also the yuan's. */
const SIGNS: Readonly<Record<string, string>> = { '\u20AC': 'EUR', '\u00A3': 'GBP', $: 'USD' };

/** The currency a column names: an ISO code in any case, or one of the signs
 *  a spreadsheet writes in its own currency column. */
function currencyOf(column: string): string {
	return SIGNS[column] ?? column.toUpperCase();
}

/** A sign or an ISO code printed at one end of an amount: `12345,67\u20AC`,
 *  `$1,234.50`, `EUR 1 000`. Spaces are already gone when this runs. */
function currencyMark(cleaned: string): { mark: string; currency: string } | undefined {
	for (const at of [cleaned.slice(0, 1), cleaned.slice(-1)]) {
		if (at in SIGNS) return { mark: at, currency: SIGNS[at] };
	}
	for (const at of [cleaned.slice(0, 3), cleaned.slice(-3)]) {
		if (/^[A-Z]{3}$/.test(at)) return { mark: at, currency: at };
	}
	return undefined;
}

/**
 * The amount of a row and the currency it is in.
 *
 * A spreadsheet in a currency format exports `12 345,67 \u20AC`, and the sign
 * used to stay glued to the number, which made every such row an invalid
 * document. The sign is dropped only when it agrees with the row's currency -
 * the column when there is one, else the sign itself, which is more specific
 * than a document default. When the two disagree the raw text is kept, so the
 * contradiction surfaces in `validate` instead of a balance silently changing
 * currency.
 */
function amountAndCurrency(
	rawAmount: string,
	column: string,
	delimiter: string,
	baseCurrency: string | undefined
): { amount: string; currency: string } {
	const cleaned = rawAmount.replace(/[\s\u00A0\u202F]/g, '');
	const found = currencyMark(cleaned);
	const currency = column || found?.currency || baseCurrency || 'EUR';
	if (found === undefined) return { amount: amountOf(cleaned, delimiter), currency };
	if (found.currency !== currency) return { amount: cleaned, currency };
	const bare = cleaned.startsWith(found.mark)
		? cleaned.slice(found.mark.length)
		: cleaned.slice(0, -found.mark.length);
	return { amount: amountOf(bare, delimiter), currency };
}

/**
 * A date as the format wants it, `YYYY-MM-DD`, from the shapes a spreadsheet
 * writes. An ISO date passes through. `24/06/2026` and `24.06.2026` are read
 * day first, `06/24/2026` month first. When both readings are possible, the
 * delimiter decides, as it does for an amount: a semicolon comes from a
 * European spreadsheet, which writes the day first. Anything else is kept as
 * written, for `validate` to refuse.
 */
function dateOf(raw: string, delimiter: string): string {
	const parts = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(raw);
	if (!parts) return raw;
	const [, first, second, year] = parts;
	const dayFirst = Number(first) > 12 || (Number(second) <= 12 && delimiter !== ',');
	const [day, month] = dayFirst ? [first, second] : [second, first];
	return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
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
			inert(String(h.label ?? '')),
			String(h.kind ?? ''),
			String(h.nature ?? ''),
			// The amount is the valuation's, so its currency must be too: a
			// holding kept in EUR but valued in USD exported a USD figure as EUR.
			String(value.currency ?? h.currency ?? doc.baseCurrency ?? ''),
			inert(institutions.get(String(h.institutionId ?? '')) ?? ''),
			String(value.amount ?? ''),
			String(v?.asOf ?? ''),
			inert(String(v?.source ?? ''))
		];
		lines.push(row.map((f) => quote(f, delimiter)).join(delimiter));
	}
	return lines.join('\n') + '\n';
}

/** An empty nature is an asset, the common case; a word that is neither is
 *  kept as written, so `validate` refuses it instead of a debt turning into an
 *  asset over a typo. */
function natureOf(raw: string): string {
	const nature = raw.toLowerCase();
	return nature === '' ? 'asset' : nature;
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
/** The lower-cased column names of a CSV's header, as `fromCsv` reads them. */
export function csvColumns(text: string, delimiter?: ',' | ';' | '\t'): string[] {
	const first = records(text).find((l) => l.trim() !== '');
	if (first === undefined) return [];
	return splitLine(first, delimiter ?? detectDelimiter(first)).map((h) => h.trim().toLowerCase());
}

export function fromCsv(text: string, options: FromCsvOptions = {}): AssetNotationDocument {
	const lines = records(text).filter((l) => l.trim() !== '');
	if (lines.length === 0) throw new Error('asset-notation: the CSV is empty');

	// Read once: the document's stamp and the date of an undated row must be
	// the same instant, and the row's was empty when no option was given.
	const generatedAt = options.generatedAt ?? new Date().toISOString();
	const delimiter = options.delimiter ?? detectDelimiter(lines[0]);
	const header = splitLine(lines[0], delimiter).map((h) => h.trim().toLowerCase());
	if (!header.includes('label') && !header.includes('amount')) {
		throw new Error('asset-notation: the CSV has neither a label nor an amount column');
	}
	// Two columns of one name: only the first was read, the second dropped unseen.
	const twice = COLUMNS.find((c) => header.indexOf(c) !== header.lastIndexOf(c));
	if (twice) throw new Error(`asset-notation: the CSV header names the column "${twice}" twice`);
	const at = (row: string[], name: string): string => {
		const i = header.indexOf(name);
		return i === -1 ? '' : revived((row[i] ?? '').trim());
	};

	const holdings: Record<string, unknown>[] = [];
	const valuations: Record<string, unknown>[] = [];
	const institutions = new Map<string, string>();

	for (let i = 1; i < lines.length; i++) {
		const row = splitLine(lines[i], delimiter);
		// A row wider than its header is a value split by the delimiter (`1234,56`
		// under a comma header); reading it would drop the cents without a word.
		if (row.length > header.length) {
			throw new Error(
				`asset-notation: row ${i + 1} has ${row.length} columns and the header ${header.length}`
			);
		}
		const label = at(row, 'label');
		const { amount, currency } = amountAndCurrency(
			at(row, 'amount'),
			currencyOf(at(row, 'currency')),
			delimiter,
			options.baseCurrency
		);
		if (label === '' && amount === '') continue;

		const id = at(row, 'id') || `h${holdings.length + 1}`;
		const holding: Record<string, unknown> = {
			id,
			kind: at(row, 'kind') || 'other',
			// A row that does not say is an asset: that is what a spreadsheet of
			// balances is, and a wrong "liability" would flip a net worth.
			nature: natureOf(at(row, 'nature')),
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
				asOf: dateOf(at(row, 'asof'), delimiter) || generatedAt.slice(0, 10),
				// A debt is worth a positive amount, as add_valuation says; a bank
				// sheet printing a loan as -90000 would otherwise RAISE the net worth.
				value: {
					amount: holding.nature === 'liability' ? amount.replace(/^-/, '') : amount,
					currency
				}
			};
			const source = at(row, 'source');
			if (source !== '') valuation.source = source;
			valuations.push(valuation);
		}
	}

	const doc: AssetNotationDocument = {
		assetnotation: options.version ?? supportedVersions().at(-1),
		generatedAt,
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
