// asset-notation - the reference implementation of the Asset Notation format.
//
//   import { validate, fromCsv, toCsv } from 'asset-notation';
//
//   const doc = fromCsv(readFileSync('accounts.csv', 'utf8'));
//   const { valid, errors } = validate(doc);
//
// Two jobs, and the second is the reason this exists. Validating tells an
// implementer whether a document is right. Converting lets someone bring the
// numbers they already keep, which is the only way a format gets a first user:
// nobody retypes their accounts to try a specification.
//
// The schemas travel inside the package, so validation works with no network
// and no registry - the same property the format itself is asking for.

export { validate, supportedVersions } from './validate.js';
export type { AssetNotationDocument, ValidationResult } from './validate.js';

export { toCsv, fromCsv, COLUMNS } from './csv.js';
export type { CsvOptions, FromCsvOptions } from './csv.js';
