// A phone keeps :hover on the last thing tapped, so a hover style looks stuck there (X49).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig.js';

test('a hover style only applies on a device that can really hover (X49)', async () => {
    const config = loadConfig(fileURLToPath(new URL('../tailwind.config.js', import.meta.url)));
    const compile = postcss([tailwindcss({ ...config, content: [{ raw: 'hover:border-white' }] })]);

    const { css } = await compile.process('@tailwind utilities;', { from: undefined });

    assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
});
