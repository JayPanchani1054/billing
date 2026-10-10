/**
 * docs/BUILD.md against the repository: the end-to-end table (§5.1) lists every Playwright spec in e2e/,
 * and nothing that no longer exists. (2.0 added seven specs that the table did not mention.)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const build = fs.readFileSync(path.join(repoRoot, 'docs/BUILD.md'), 'utf8').replace(/\r\n?/g, '\n');

describe('docs/BUILD.md', () => {
  it('§5.1 lists every e2e spec, and only existing ones', () => {
    const start = build.indexOf('### 5.1 End-to-end suite');
    assert.ok(start >= 0, 'BUILD.md has no "### 5.1 End-to-end suite" section');
    const rest = build.slice(start + 1);
    const next = rest.search(/\n#{2,3} /);
    const table = next < 0 ? rest : rest.slice(0, next);
    const listed = [...table.matchAll(/^\| `(e2e\/[^`]+\.spec\.ts)` \|/gm)].map((m) => m[1]).sort();
    const specs = fs
      .readdirSync(path.join(repoRoot, 'e2e'))
      .filter((f) => f.endsWith('.spec.ts'))
      .map((f) => `e2e/${f}`)
      .sort();
    assert.ok(specs.length > 0);
    assert.deepEqual(listed, specs);
  });
});
