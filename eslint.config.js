import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
	{ ignores: ['dist/**', 'node_modules/**', 'schema/**', 'examples/**'] },
	js.configs.recommended,
	...ts.configs.recommended,
	{
		languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'no-console': 'off'
		}
	}
);
