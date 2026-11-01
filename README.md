# asset-notation

[![npm](https://img.shields.io/npm/v/asset-notation)](https://www.npmjs.com/package/asset-notation)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Reference implementation of [Asset Notation](https://github.com/assetnotation/spec), an
open format for what you own and owe, over time.

Three jobs. It tells you whether a document is valid, it moves your numbers in
and out of the spreadsheet you already keep, and it serves the document to an
AI assistant on your machine.

```bash
npx asset-notation validate portfolio.json
npx asset-notation from-csv accounts.csv > portfolio.json
npx asset-notation to-csv   portfolio.json > accounts.csv
npx asset-notation mcp      wealth.json
```

```ts
import { validate, fromCsv, toCsv } from 'asset-notation';

const doc = fromCsv(readFileSync('accounts.csv', 'utf8'));
const { valid, errors, notes } = validate(doc);
```

## Why the CSV half exists

Nobody retypes their accounts to try a specification. A format you cannot get
your existing numbers into is a format you never start using, so the converter
is not a convenience here, it is the front door.

One row is one holding and what it was last worth, which is the shape everyone
already has: a line per account, a label, a balance, a date.

Two details decide whether this works outside an English-speaking office, and
both are handled rather than documented away:

- A spreadsheet saved from a **French, German or Spanish Excel separates columns
  with a semicolon** and writes decimals with a comma. Read as comma-separated,
  `4210,55` becomes two columns and every balance is destroyed. The delimiter is
  detected from the header, and an amount is read against the delimiter found.
- **Amounts stay strings**, all the way through. No float ever rounds a balance.

Thousands grouping is dropped, including the no-break spaces a spreadsheet
writes (`1 234,56` and `1,234.56` both land on `1234.56`). A date is read the
same way: `24/06/2026` and `24.06.2026` day first, `06/24/2026` month first, and
when both fit, the delimiter decides.

## Use it from an AI assistant

`asset-notation mcp <file.json>` is a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio. The assistant reads and maintains the file. The server itself
opens no socket and uses no network, but every answer it gives goes to the
assistant, and the assistant decides where it goes next: an assistant whose model
runs in the cloud sends the document to its provider. Choose the client with that
in mind. The file is created on the first holding when it does not exist.

In the configuration file of an assistant's desktop app, or of any MCP client,
under `mcpServers`:

```json
{
	"mcpServers": {
		"wealth": { "command": "npx", "args": ["-y", "asset-notation", "mcp", "/home/you/wealth.json"] }
	}
}
```

The same entry for a generic MCP client: command `npx`, arguments
`-y asset-notation mcp /home/you/wealth.json`, transport stdio. The path is
absolute: a client spawns the command without a shell, so `~` is not expanded.

Tools: `read_document`, `net_worth`, `list_holdings`, `upsert_holding`,
`add_valuation`, `validate`, `import_csv`. Resource: `asset-notation://document`.
Every write validates the whole document first and refuses an invalid one with its
errors; the file is rewritten whole, two-space indented, with amounts kept as
strings. `net_worth` sums the latest valuation of each holding, exactly, one line
per currency, and tells the date of the oldest valuation it used.

### If you are an AI asked to manage someone's wealth

This package reads and writes one JSON file in the Asset Notation format: a list of
`holdings` (accounts, properties, loans, each an `asset` or a `liability`), of
`institutions`, and of dated `valuations` whose amounts are decimal strings. Start
it with `npx -y asset-notation mcp <file.json>`, then call `list_holdings`, record
values with `add_valuation`, and answer with `net_worth`. Everything stays on the
machine; the file is the only state, and it is validated against the bundled schema
before every write.

## Validating

The schema is chosen by the version the document declares, matched on
major.minor: a document says what it is and is judged against that. **Schemas
ship inside the package**, so validation needs no network and no registry - the
same property the format itself is asking for.

On top of the schema, the document-level rules a JSON Schema cannot express:

| Situation                                                             | Verdict               |
| --------------------------------------------------------------------- | --------------------- |
| An id used twice in one collection                                    | **error**             |
| A chain of `parentId` that comes back on itself                       | **error**             |
| Two ownership rows of one subject on one holding that overlap in time | **error**             |
| A reference pointing at something absent                              | **note**, still valid |
| Ownership shares of one holding summing above 1                       | **note**, still valid |

The unresolved reference is deliberate and it is the interesting one. Any subset of a
valid document is itself valid, so a statement covering three accounts out of
twelve, naming a bank it does not describe, is a legitimate partial disclosure -
not a broken file. Reporting it as an error would forbid exactly the sharing the
format exists for.

`validate()` never throws on a malformed document: reporting what is wrong is
the job.

The specification's conformance corpus (`conformance/`, one file per version,
mirrored verbatim like the schemas) runs in the test suite: every case states
the verdict this validator must reach, so the library and the specification
cannot drift apart silently.

## API

```ts
validate(doc: unknown): {
  valid: boolean;
  schemaVersion: string | null;
  errors: string[];   // what makes it invalid
  notes: string[];    // true, and not a fault
}

supportedVersions(): string[]

toCsv(doc, { delimiter? }): string
fromCsv(text, { delimiter?, generatedAt?, version?, baseCurrency? }): Document

netWorth(doc): {
  byCurrency: { currency, assets, liabilities, net }[];  // decimal strings
  oldestAsOf: string | null;
  unvaluedHoldingIds: string[];
  valuedHoldings: number;
}
```

`fromCsv` takes `generatedAt` rather than reading the clock, so the same input
always produces the same bytes - which is what lets a converted file be diffed
or committed.

## Exit codes

`0` valid, `1` invalid, `2` the command was wrong. Diagnostics go to stderr and
the result to stdout, so a conversion can be piped while its warnings stay
readable.

## Licence

Apache-2.0, the same as the specification.
