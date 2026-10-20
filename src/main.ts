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
import { serve } from './mcp.js';

export interface Streams {
	stdout: { write(text: string): unknown };
	stderr: { write(text: string): unknown };
}

const USAGE = `asset-notation <command> <file>

  validate <file.json>   judge a document, and say why if it fails
  to-csv   <file.json>   write it as a spreadsheet, one row per holding
  from-csv <file.csv>    read a spreadsheet into a document
  mcp      <file.json>   serve the document to an AI assistant (MCP over stdio)

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

type Command = (file: string | undefined, io: Streams) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
	validate(file, io) {
		const result = validate(parse(read(file), file ?? ''));
		for (const note of result.notes) io.stderr.write(`note   ${note}\n`);
		for (const error of result.errors) io.stderr.write(`error  ${error}\n`);
		if (!result.valid) return 1;
		io.stderr.write(`valid  Asset Notation ${result.schemaVersion}\n`);
		return 0;
	},
	'to-csv'(file, io) {
		const doc = parse(read(file), file ?? '') as Record<string, unknown>;
		// Judged before it is written: `holdings` given as an object exported a
		// header alone and exited 0, an empty portfolio instead of an error.
		const result = validate(doc);
		for (const error of result.errors) io.stderr.write(`error  ${error}\n`);
		if (!result.valid) return 1;
		io.stdout.write(toCsv(doc));
		return 0;
	},
	'from-csv'(file, io) {
		const doc = convert(read(file));
		// Converted, then judged: handing back a document this library itself
		// would reject is worse than failing, because the fault would surface
		// later and somewhere else.
		const result = validate(doc);
		for (const error of result.errors) io.stderr.write(`error  ${error}\n`);
		io.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
		return result.valid ? 0 : 1;
	},
	mcp(file) {
		if (!file) throw new Failure(USAGE, 2);
		// The server owns stdout from here: the protocol speaks on it, so no
		// diagnostic of ours may. It answers when the assistant hangs up.
		return serve(file).then(() => 0);
	}
};

function dispatch(
	command: string | undefined,
	file: string | undefined,
	io: Streams
): number | Promise<number> {
	const known = command !== undefined && Object.hasOwn(COMMANDS, command);
	const run = known ? COMMANDS[command] : undefined;
	if (!run) throw new Failure(USAGE, 2);
	return run(file, io);
}

function report(error: unknown, io: Streams): number {
	if (!(error instanceof Failure)) throw error;
	io.stderr.write(`${error.message}\n`);
	return error.code;
}

/** Run one command and answer with its exit code: at once for a conversion, and
 *  once the assistant hangs up for `mcp`. */
export function run(argv: string[], io: Streams): number | Promise<number> {
	const [command, file] = argv;
	try {
		const code = dispatch(command, file, io);
		return typeof code === 'number' ? code : code.catch((error: unknown) => report(error, io));
	} catch (error) {
		return report(error, io);
	}
}
