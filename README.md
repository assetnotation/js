# asset-notation

[![npm](https://img.shields.io/npm/v/asset-notation)](https://www.npmjs.com/package/asset-notation)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Reference implementation of [Asset Notation](https://github.com/assetnotation/spec), an
open format for what you own and owe, over time.

Two jobs. It tells you whether a document is valid, and it moves your numbers in
and out of the spreadsheet you already keep.

```bash
npx asset-notation validate portfolio.json
npx asset-notation from-csv accounts.csv > portfolio.json
npx asset-notation to-csv   portfolio.json > accounts.csv
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
writes (`1 234,56` and `1,234.56` both land on `1234.56`).

## Validating

The schema is chosen by the version the document declares, matched on
major.minor: a document says what it is and is judged against that. **Schemas
ship inside the package**, so validation needs no network and no registry - the
same property the format itself is asking for.

On top of the schema, two document-level rules a JSON Schema cannot express:

| Situation                                | Verdict               |
| ---------------------------------------- | --------------------- |
| An id used twice in one collection       | **error**             |
| A reference pointing at something absent | **note**, still valid |

The second one is deliberate and it is the interesting one. Any subset of a
valid document is itself valid, so a statement covering three accounts out of
twelve, naming a bank it does not describe, is a legitimate partial disclosure -
not a broken file. Reporting it as an error would forbid exactly the sharing the
format exists for.

`validate()` never throws on a malformed document: reporting what is wrong is
the job.

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
