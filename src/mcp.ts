/**
 * The document as a set of tools an AI assistant can call, over the Model
 * Context Protocol on standard input and output. The assistant runs on the
 * same machine as the file; nothing here opens a socket or reads anything but
 * that one file.
 *
 * Every tool is a plain function over the file (`wealthTools`), so each can be
 * tested without a transport; `serve` is the thin layer that hands them to the
 * protocol. A write validates the whole document first and refuses an invalid
 * one with its errors: a file this library itself would reject must never be
 * what the next read finds.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import {
	addValuation,
	emptyDocument,
	listHoldings,
	mergeCsv,
	netWorth,
	normalize,
	upsertHolding
} from './wealth.js';
import { validate, type AssetNotationDocument } from './validate.js';

/** A tool's refusal: what is wrong, as the assistant should read it. */
export class Refusal extends Error {
	constructor(
		message: string,
		readonly details: string[] = []
	) {
		super(message);
	}
}

export interface Tool {
	name: string;
	description: string;
	inputSchema: z.ZodRawShape;
	/** `true` when the tool changes nothing. */
	readOnly: boolean;
	run(args: Record<string, unknown>): unknown;
}

const DECIMAL = z.string().regex(/^-?\d+(\.\d+)?$/, 'a decimal string such as "4210.55"');
const CURRENCY = z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 code such as "EUR"');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD, or an RFC 3339 timestamp');

const holdingShape = {
	id: z
		.string()
		.min(1)
		.optional()
		.describe('Id of the holding to update, or to give the new one. Omit it to mint one.'),
	label: z
		.string()
		.optional()
		.describe('What the person calls it: "Current account", "Flat on Main St".'),
	kind: z
		.string()
		.min(1)
		.optional()
		.describe(
			'checking, savings, brokerage, retirement, real_estate, crypto, loan, mortgage, credit_card, other...'
		),
	nature: z
		.enum(['asset', 'liability'])
		.optional()
		.describe('asset (owned) or liability (owed). New holdings default to asset.'),
	currency: CURRENCY.optional(),
	institution: z
		.string()
		.optional()
		.describe('Name of the bank, broker or lender. Matched by name, created when new.'),
	parentId: z
		.string()
		.optional()
		.describe('Id of the holding that contains this one, such as the account holding a position.'),
	instrumentId: z.string().optional(),
	quantity: DECIMAL.optional().describe('Units held, as a decimal string.'),
	attributes: z
		.record(z.string(), z.unknown())
		.optional()
		.describe('Free key-values: rate, endDate, payment...'),
	openedAt: z.string().optional(),
	closedAt: z.string().optional()
};

const valuationShape = {
	holdingId: z.string().min(1).describe('The holding this value belongs to.'),
	asOf: DATE.describe('The date the value is true for.'),
	amount: DECIMAL.describe('The value as a decimal STRING, positive for both assets and debts.'),
	currency: CURRENCY,
	source: z
		.string()
		.optional()
		.describe('Where the number comes from: statement, market, estimate, user...'),
	confidence: z.number().min(0).max(1).optional(),
	quantity: DECIMAL.optional().describe('Units held on that date, as a decimal string.')
};

const csvShape = {
	csv: z
		.string()
		.min(1)
		.describe(
			'The spreadsheet text, with a header row. Columns: label, amount, asOf, currency, kind, nature, institution, source, id.'
		),
	baseCurrency: CURRENCY.optional().describe('Currency of rows that name none.')
};

/** The one file, read and written whole. */
class WealthFile {
	/** The bytes the last read found, `null` for no file: what a write expects to replace. */
	private seen: string | null | undefined;

	constructor(
		readonly path: string,
		private readonly now: () => string
	) {}

	exists(): boolean {
		return existsSync(this.path);
	}

	read(): AssetNotationDocument {
		if (!this.exists())
			throw new Refusal(`${this.path} does not exist yet; upsert_holding or import_csv creates it`);
		let parsed: unknown;
		try {
			this.seen = readFileSync(this.path, 'utf8');
			parsed = JSON.parse(this.seen);
		} catch (error) {
			throw new Refusal(`${this.path} is not JSON: ${(error as Error).message}`);
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Refusal(`${this.path} is not a JSON object`);
		}
		return parsed as AssetNotationDocument;
	}

	/**
	 * The document, refused when it does not validate: a total or a change
	 * computed over a malformed `holdings` would read it as empty, and the
	 * write would then replace what the file held with that emptiness.
	 */
	readValid(): AssetNotationDocument {
		const doc = this.read();
		const result = validate(doc);
		if (!result.valid)
			throw new Refusal(
				`${this.path} is not a valid document; the validate tool lists why, nothing was read or changed`,
				result.errors
			);
		return doc;
	}

	/** The valid document, or a fresh one when the file is not there yet. */
	readOrEmpty(): AssetNotationDocument {
		if (this.exists()) return this.readValid();
		this.seen = null;
		return emptyDocument(this.now());
	}

	/** What the file holds now, `null` when it is gone. */
	private current(): string | null {
		return this.exists() ? readFileSync(this.path, 'utf8') : null;
	}

	/** Validate, then write the whole file: two-space indent, one trailing newline. */
	write(doc: AssetNotationDocument): AssetNotationDocument {
		const final = normalize(doc, this.now());
		const result = validate(final);
		if (!result.valid)
			throw new Refusal(
				'the change would make the document invalid; nothing was written',
				result.errors
			);
		mkdirSync(dirname(this.path), { recursive: true });
		// Written beside, then renamed over: an interrupted write or a full disk
		// leaves the previous file whole instead of a truncated one.
		const temporary = `${this.path}.${process.pid}.tmp`;
		const text = `${JSON.stringify(final, null, 2)}\n`;
		writeFileSync(temporary, text, { flush: true });
		// One server process per client: a second one may have written since
		// this change was read, and renaming over it would erase its change.
		if (this.seen !== undefined && this.current() !== this.seen) {
			unlinkSync(temporary);
			throw new Refusal(
				`${this.path} changed since it was read, by another writer; nothing was written, run the tool again`
			);
		}
		renameSync(temporary, this.path);
		this.seen = text;
		return final;
	}
}

/** The tools over one file. `now` is injectable so a test writes the same bytes twice. */
export function wealthTools(
	path: string,
	now: () => string = () => new Date().toISOString()
): Tool[] {
	const file = new WealthFile(path, now);
	return [
		{
			name: 'read_document',
			description:
				'Read the whole Asset Notation document: every holding (account, property, loan...), institution, valuation and ownership share. Use it when you need a detail list_holdings and net_worth do not give.',
			inputSchema: {},
			readOnly: true,
			run: () => file.read()
		},
		{
			name: 'net_worth',
			description:
				'What the person is worth: assets minus liabilities, per currency, from the latest valuation of each holding, summed exactly. Also tells the date of the oldest valuation used and the holdings that have none. Call it when asked for net worth, total wealth or a summary.',
			inputSchema: {},
			readOnly: true,
			run: () => netWorth(file.readValid())
		},
		{
			name: 'list_holdings',
			description:
				'List every holding with its institution name and latest valuation. Call it before updating or valuing a holding, to find its id.',
			inputSchema: {},
			readOnly: true,
			run: () => listHoldings(file.readValid())
		},
		{
			name: 'upsert_holding',
			description:
				'Create a holding (an account, a property, a loan...) or update the fields given on the one with that id; fields you do not pass are kept. Creates the file when it does not exist. Does not record a value: call add_valuation for that.',
			inputSchema: holdingShape,
			readOnly: false,
			run: (args) => {
				const { doc, holding } = upsertHolding(
					file.readOrEmpty(),
					args as unknown as Parameters<typeof upsertHolding>[1]
				);
				file.write(doc);
				return holding;
			}
		},
		{
			name: 'add_valuation',
			description:
				'Record what a holding was worth on a date. Adds to the history, never replaces: the latest date wins in net_worth. Amounts are decimal strings, positive for assets and for debts alike.',
			inputSchema: valuationShape,
			readOnly: false,
			run: (args) => {
				const { doc, valuation } = addValuation(
					file.readValid(),
					args as unknown as Parameters<typeof addValuation>[1]
				);
				file.write(doc);
				return valuation;
			}
		},
		{
			name: 'validate',
			description:
				'Judge the document against its declared schema version and the integrity rules. Returns valid, errors (faults) and notes (true observations that are not faults).',
			inputSchema: {},
			readOnly: true,
			run: () => validate(file.read())
		},
		{
			name: 'import_csv',
			description:
				'Merge a spreadsheet (CSV text, one row per holding with label, amount, asOf...) into the document. Rows match existing holdings by id or label and update them; the rest become new holdings. Each amount becomes a valuation. Comma or semicolon separated, decimals with a point or a comma. Creates the file when it does not exist.',
			inputSchema: csvShape,
			readOnly: false,
			run: (args) => {
				const { csv, baseCurrency } = args as { csv: string; baseCurrency?: string };
				let merged: ReturnType<typeof mergeCsv>;
				try {
					merged = mergeCsv(file.readOrEmpty(), csv, { baseCurrency, generatedAt: now() });
				} catch (error) {
					throw new Refusal((error as Error).message.replace(/^asset-notation: /, ''));
				}
				file.write(merged.doc);
				return { holdingIds: merged.holdingIds, valuations: merged.valuations };
			}
		}
	];
}

export const DOCUMENT_URI = 'asset-notation://document';

function asText(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export interface Pipes {
	stdin: Readable;
	stdout: Writable;
}

/** Serve the file over MCP on the two pipes. Resolves when the assistant hangs
 *  up: the transport closes, or its input simply ends. */
export async function serve(path: string, pipes: Pipes = process): Promise<void> {
	const server = new McpServer({ name: 'asset-notation', version: packageVersion() });
	for (const tool of wealthTools(path)) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false }
			},
			(args: Record<string, unknown>) => {
				try {
					return { content: [{ type: 'text' as const, text: asText(tool.run(args ?? {})) }] };
				} catch (error) {
					if (!(error instanceof Refusal)) throw error;
					const text = [error.message, ...error.details.map((d) => `error  ${d}`)].join('\n');
					return { content: [{ type: 'text' as const, text }], isError: true };
				}
			}
		);
	}
	server.registerResource(
		'document',
		DOCUMENT_URI,
		{
			description: 'The Asset Notation document, as stored on disk.',
			mimeType: 'application/json'
		},
		() => ({
			contents: [
				{ uri: DOCUMENT_URI, mimeType: 'application/json', text: readFileSync(path, 'utf8') }
			]
		})
	);
	const closed = new Promise<void>((resolve) => {
		server.server.onclose = resolve;
		// The transport does not treat the end of its input as a hang-up; a
		// client that exits leaves the process waiting on nothing otherwise.
		pipes.stdin.once('end', () => void server.close().then(resolve, resolve));
	});
	await server.connect(new StdioServerTransport(pipes.stdin, pipes.stdout));
	await closed;
}

function packageVersion(): string {
	try {
		const url = new URL('../package.json', import.meta.url);
		return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
	} catch {
		return '0.0.0';
	}
}
