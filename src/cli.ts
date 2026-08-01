#!/usr/bin/env node
/**
 * The command line, because the first thing anyone does with a format is check
 * a file they were handed, and asking them to write a script first is asking
 * them not to bother.
 *
 *   npx asset-notation validate portfolio.json
 *   npx asset-notation to-csv portfolio.json > accounts.csv
 *   npx asset-notation from-csv accounts.csv > portfolio.json
 *
 * Exit codes are the contract: 0 valid, 1 invalid, 2 the command was wrong.
 * Diagnostics go to stderr and the result to stdout, so a conversion can be
 * piped while its warnings stay readable.
 */

import { readFileSync } from 'node:fs';
import { validate, supportedVersions } from './validate.js';
import { toCsv, fromCsv } from './csv.js';

const USAGE = `asset-notation <command> <file>

  validate <file.json>   judge a document, and say why if it fails
  to-csv   <file.json>   write it as a spreadsheet, one row per holding
  from-csv <file.csv>    read a spreadsheet into a document

Schemas bundled: ${supportedVersions().join(', ')}`;

function read(file: string | undefined): string {
	if (!file) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	try {
		return readFileSync(file, 'utf8');
	} catch {
		process.stderr.write(`asset-notation: cannot read ${file}\n`);
		process.exit(2);
	}
}

const [command, file] = process.argv.slice(2);

if (command === 'validate') {
	const result = validate(JSON.parse(read(file)));
	for (const note of result.notes) process.stderr.write(`note   ${note}\n`);
	for (const error of result.errors) process.stderr.write(`error  ${error}\n`);
	if (result.valid) {
		process.stderr.write(`valid  Asset Notation ${result.schemaVersion}\n`);
		process.exit(0);
	}
	process.exit(1);
} else if (command === 'to-csv') {
	process.stdout.write(toCsv(JSON.parse(read(file))));
} else if (command === 'from-csv') {
	const doc = fromCsv(read(file));
	// Converted, then judged: handing back a document this library itself would
	// reject is worse than failing, because the fault would surface later and
	// somewhere else.
	const result = validate(doc);
	for (const error of result.errors) process.stderr.write(`error  ${error}\n`);
	process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
	if (!result.valid) process.exit(1);
} else {
	process.stderr.write(`${USAGE}\n`);
	process.exit(2);
}
