/**
 * Exact arithmetic on the decimal strings the format carries. A balance is
 * never a float here: every amount is scaled to an integer on the longest
 * fraction present, summed as a bigint, and written back with that fraction.
 */

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** True when the text is a decimal string the schema would accept. */
export function isDecimal(text: unknown): text is string {
	return typeof text === 'string' && DECIMAL.test(text);
}

function scaled(value: string, scale: number): bigint {
	const negative = value.startsWith('-');
	const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
	const magnitude = BigInt(whole + fraction.padEnd(scale, '0'));
	return negative ? -magnitude : magnitude;
}

function unscaled(total: bigint, scale: number): string {
	const sign = total < 0n ? '-' : '';
	const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
	if (scale === 0) return sign + digits;
	return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** The exact sum of decimal strings, with as many decimals as the most
 *  precise of them. `["10", "-2.50"]` is `"7.50"`. */
export function sumDecimals(values: string[]): string {
	const scale = Math.max(0, ...values.map((v) => v.split('.')[1]?.length ?? 0));
	const total = values.reduce((acc, v) => acc + scaled(v, scale), 0n);
	return unscaled(total, scale);
}

/** The opposite of a decimal string: `"7.50"` is `"-7.50"`, `"-2"` is `"2"`. */
export function negateDecimal(value: string): string {
	if (/^-?0+(\.0+)?$/.test(value)) return value.replace(/^-/, '');
	return value.startsWith('-') ? value.slice(1) : `-${value}`;
}
