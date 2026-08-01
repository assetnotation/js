import { defineConfig } from 'tsup';

// The schemas are read from disk at runtime rather than inlined: they are the
// normative artefact, and a consumer who wants to see what they are being
// judged against must be able to open the file.
export default defineConfig({
	entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
	format: ['esm'],
	clean: true,
	target: 'node20',
	platform: 'node'
});
