/**
 * The MCP registry reads `server.json` and the published package's `mcpName`,
 * and refuses a server whose version is not the package's. Both files live
 * here, so the agreement is checked here, before a tag is cut.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<
	string,
	unknown
>;
const server = JSON.parse(
	readFileSync(new URL('../server.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

describe('the MCP registry entry', () => {
	it('names the same server as package.json, at the same version', () => {
		expect(server.name).toBe(pkg.mcpName);
		expect(server.name).toMatch(/^io\.github\.assetnotation\//);
		expect(server.version).toBe(pkg.version);
	});

	it('points at this npm package, at the same version, over stdio', () => {
		expect(server.packages).toEqual([
			expect.objectContaining({
				registryType: 'npm',
				identifier: pkg.name,
				version: pkg.version,
				transport: { type: 'stdio' }
			})
		]);
	});
});
