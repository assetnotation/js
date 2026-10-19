/**
 * The command line, as a function: it takes the arguments and the two streams,
 * and answers with the exit code, so it can be exercised without spawning a
 * process. `cli.ts` is the executable wrapper around it.
 *
 * Exit codes are the contract: 0 valid, 1 invalid, 2 the command was wrong.
 * Diagnostics go to stderr and the result to stdout, so a conversion can be
 * piped while its warnings stay readable. A file that is not JSON, or a
 * spreadsheet that cannot be read, is a diagnostic like any other: one line
 * and exit code 1, never a stack trace.
 */

import { readFileSync } from 'node:fs';
import { validate, supportedVersions } from './validate.js';
import { toCsv, fromCsv } from './csv.js';

export interface Streams {
	stdout: { write(text: string): unknown };
	stderr: { write(text: string): unknown };
}

const USAGE = `asset-notation <command> <file>

  validate <file.json>   judge a document, and say why if it fails
  to-csv   <file.json>   write it as a spreadsheet, one row per holding
  from-csv <file.csv>    read a spreadsheet into a document

Schemas bundled: ${supportedVersions().join(', ')}`;

/** Thrown for a diagnostic that ends the run: its message is the line printed. */
class Failure extends Error {
	constructor(
		message: string,
		readonly code: 1 | 2
	) {
		super(message);
	}
}

function read(file: string | undefined): string {
	if (!file) throw new Failure(USAGE, 2);
	try {
		return readFileSync(file, 'utf8');
	} catch {
		throw new Failure(`asset-notation: cannot read ${file}`, 2);
	}
}

function parse(text: string, file: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Failure(`error  ${file} is not JSON: ${(error as Error).message}`, 1);
	}
}

function convert(text: string): ReturnType<typeof fromCsv> {
	try {
		return fromCsv(text);
	} catch (error) {
		throw new Failure(`error  ${(error as Error).message.replace(/^asset-notation: /, '')}`, 1);
	}
}

function dispatch(command: string | undefined, file: string | undefined, io: Streams): number {
	if (command === 'validate') {
		const result = validate(parse(read(file), file ?? ''));
		for (const note of result.notes) io.stderr.write(`note   ${note}\n`);
		for (const error of result.errors) io.stderr.write(`error  ${error}\n`);
		if (!result.valid) return 1;
		io.stderr.write(`valid  Asset Notation ${result.schemaVersion}\n`);
		return 0;
	}
	if (command === 'to-csv') {
		io.stdout.write(toCsv(parse(read(file), file ?? '') as Record<string, unknown>));
		return 0;
	}
	if (command === 'from-csv') {
		const doc = convert(read(file));
		// Converted, then judged: handing back a document this library itself
		// would reject is worse than failing, because the fault would surface
		// later and somewhere else.
		const result = validate(doc);
		for (const error of result.errors) io.stderr.write(`error  ${error}\n`);
		io.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
		return result.valid ? 0 : 1;
	}
	throw new Failure(USAGE, 2);
}

/** Run one command and answer with its exit code. */
export function run(argv: string[], io: Streams): number {
	const [command, file] = argv;
	try {
		return dispatch(command, file, io);
	} catch (error) {
		if (!(error instanceof Failure)) throw error;
		io.stderr.write(`${error.message}\n`);
		return error.code;
	}
}
