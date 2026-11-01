/**
 * A temporary written in part (a full disk, a failed flush) must not stay
 * beside the document: it holds a copy of a net worth.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (original) => {
	const fs = await original<typeof import('node:fs')>();
	return {
		...fs,
		writeFileSync: (file: string, data: string, options?: object) => {
			if (String(file).endsWith('.tmp') && process.env.FAIL_TEMP === '1') {
				fs.writeFileSync(file, String(data).slice(0, 10), options);
				throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
			}
			return fs.writeFileSync(file, data, options);
		}
	};
});

const { wealthTools } = await import('./mcp.js');

describe('a temporary that fails half way', () => {
	it('is removed, and the document stays whole', () => {
		const dir = mkdtempSync(join(tmpdir(), 'asset-notation-fail-'));
		const path = join(dir, 'wealth.json');
		const tools = Object.fromEntries(
			wealthTools(path, () => '2026-11-01T10:00:00.000Z').map((t) => [t.name, t])
		);
		tools.upsert_holding.run({ id: 'h1', label: 'Livret' });
		const before = readFileSync(path, 'utf8');
		process.env.FAIL_TEMP = '1';
		try {
			expect(() => tools.upsert_holding.run({ id: 'h1', label: 'Livret A' })).toThrow('no space');
		} finally {
			delete process.env.FAIL_TEMP;
		}
		expect(readFileSync(path, 'utf8')).toBe(before);
		expect(readdirSync(dir)).toEqual(['wealth.json']);
	});
});
