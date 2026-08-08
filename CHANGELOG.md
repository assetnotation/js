# Changelog

## [Unreleased]

### Fixed

- `fromCsv`: an amount grouped with dots and pointed with a comma - `1.234,56`,
  what a German or Spanish spreadsheet writes - was read as `1.23456`, a
  thousandth of the balance, with nothing raised. Which mark is the decimal one
  is now decided by position: the rightmost of the two, always. The 0.1.0 notes
  below already promised this case worked.

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
