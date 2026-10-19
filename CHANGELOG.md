# Changelog

## [Unreleased]

## [0.1.5] - 2026-10-20

### Added

- Specification 0.4.0: schema `0.4.0` bundled (`from` and `until` on ownership
  rows), examples mirrored, and the specification's conformance corpus
  (`conformance/`) run by the test suite, 101 cases on 0.4.0.
- `validate`: a `parentId` chain that comes back on itself is an error, as
  section 4 of the specification now says; a note in 0.1.4.
- `validate`: two ownership rows of one subject on one holding whose intervals
  overlap are an error (section 5.7).
- `fromCsv` declares `0.4.0` by default, the newest schema bundled.

## [0.1.4] - 2026-10-19

### Fixed

- `fromCsv`: a date written the way a French, German or Spanish spreadsheet
  writes it - `24/06/2026`, `24.06.2026` - reached the document as written,
  where the schema refuses it. It is now read day first; `06/24/2026` month
  first; when both fit, the delimiter decides, as it does for an amount.
- `fromCsv`: a currency column holding a sign (`€`, `$`, `£`) rather than a
  code made the row invalid; the sign is now read as its code.
- `fromCsv`: the version declared by default was a fixed `0.3.0`; it is now
  the newest schema the build ships, as documented.
- CLI: a file that is not JSON, an empty spreadsheet or an unclosed quote
  ended in a stack trace. Each is now one `error` line on stderr and exit
  code 1, as the other diagnostics are.

### Added

- `validate` notes, on a document that stays valid: a chain of `parentId`
  that comes back on itself, and a holding whose ownership shares sum to more
  than 1 (summed exactly, never as floats).
- `supportedVersions()` lists versions in numeric order, oldest first.

## [0.1.3] - 2026-10-18

### Fixed

- `validate`: a `null` (or any non-object) in a collection or in a holding's
  `links` threw instead of answering; it is now left to the schema, which
  reports it as an error.
- `toCsv`: the currency column took the holding's currency while the amount
  is the valuation's, so a holding kept in EUR and valued in USD exported a USD
  figure labelled EUR. The column now carries the currency of the amount.
- `fromCsv`: without a `generatedAt` option, an undated row got an empty
  `asOf` and the document failed validation. The stamp is now read once and
  dates both.
- `fromCsv`: a quoted field holding a line break, which `toCsv` writes, was
  cut into two rows. Records are now read whole, and an unclosed quote is
  refused instead of swallowing the rest of the file.
- `fromCsv`: a header with neither a `label` nor an `amount` column produced an
  empty document that passed validation; it is now refused.
- `fromCsv`: a nature that is neither `asset` nor `liability` was read as an
  asset, so a misspelt debt became an asset. It is now kept as written and
  `validate` refuses it; an empty nature is still an asset.
- `toCsv`: the latest valuation was chosen by text order, which offsets break;
  it is now chosen by instant.

## [0.1.2] - 2026-10-08

### Fixed

- `fromCsv`: an amount exported from a cell formatted as currency -
  `12 345,67 €`, `$1,234.50`, `EUR 1 000` - kept its sign glued to the number,
  so every such row produced an amount the schema refuses. A sign or an ISO code
  at either end of the amount is now read as the row's currency and dropped:
  it fills an empty currency column and wins over `baseCurrency`, which is a
  document default. When it contradicts the row's own currency column, nothing
  is guessed: the raw text stays and `validate` reports it, rather than a
  balance silently changing currency. The yen sign is not read, since the yuan
  writes the same one.

## [0.1.1] - 2026-08-09

### Fixed

- `fromCsv`: an amount grouped with dots and pointed with a comma - `1.234,56`,
  what a German or Spanish spreadsheet writes - was read as `1.23456`, a
  thousandth of the balance, with nothing raised. Which mark is the decimal one
  is now decided by position: the rightmost of the two, always. The 0.1.0 notes
  below already promised this case worked.

### Added

- A publish workflow, so a fix reaches the people who installed the package
  rather than only the people who read the repository. This one sat corrected
  on `main` while npm went on serving the version that divides by a thousand.
  It authenticates by OIDC against a trusted publisher declared on npmjs.com,
  so there is no credential in the repository to rotate, leak or let expire,
  and it publishes a tag rather than a branch.

## [0.1.0] - 2026-08-01

First release. The reference implementation the specification did not have: an
implementer had a JSON Schema, three examples, and nothing else.

### Added

- `validate(doc)`: the declared version chooses the schema, matched on
  major.minor, and two document-level rules ride on top - a duplicate id is an
  error, an unresolved reference is a note and stays valid, because any subset
  of a valid document is a legitimate partial disclosure. Schemas ship inside
  the package, so validation needs no network.
- `fromCsv` / `toCsv`: the bridge to the spreadsheet people already keep. A
  semicolon-separated export with comma decimals - what a French, German or
  Spanish Excel writes - is read correctly, thousands grouping and no-break
  spaces included. Amounts stay strings end to end, so no float rounds a
  balance.
- `asset-notation` on the command line: validate, to-csv, from-csv. Exit 0
  valid, 1 invalid, 2 wrong command.
