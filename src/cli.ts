#!/usr/bin/env node
/**
 * The command line, because the first thing anyone does with a format is check
 * a file they were handed, and asking them to write a script first is asking
 * them not to bother.
 *
 *   npx asset-notation validate portfolio.json
 *   npx asset-notation to-csv portfolio.json > accounts.csv
 *   npx asset-notation from-csv accounts.csv > portfolio.json
 *   npx asset-notation mcp wealth.json
 *
 * The work is in `main.ts`, so it can be tested in-process.
 */

import { run } from './main.js';

// exitCode and not exit(): exit() ends the process before a pipe has taken
// the last of stdout, and a large conversion arrives cut under a success code.
process.exitCode = await run(process.argv.slice(2), process);
