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
 * The work is in `main.ts`, so it can be tested in-process.
 */

import { run } from './main.js';

process.exit(run(process.argv.slice(2), process));
