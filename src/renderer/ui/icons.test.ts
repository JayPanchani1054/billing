import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ICON_NAMES, ICONS, isIconName } from './icons.ts';

test('every icon draws something: stroked `d` paths or filled dots', () => {
  for (const name of ICON_NAMES) {
    const def: { d: readonly string[]; fill?: readonly string[] } = ICONS[name];
    assert.ok(def.d.length + (def.fill?.length ?? 0) > 0, name);
  }
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
});

test('2.2 "text" (a voucher line description): three lines of text, the last one shorter, inside the 2 px padding', () => {
  assert.ok(isIconName('text'));
  const lines = ICONS.text.d.map((d) => {
    const m = /^M(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)$/.exec(d);
    assert.ok(m, `${d} is one horizontal stroke`);
    return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) };
  });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].y < lines[1].y && lines[1].y < lines[2].y, 'top to bottom');
  assert.equal(lines[0].w, lines[1].w);
  assert.ok(lines[2].w < lines[1].w, 'the last line is shorter');
  assert.ok(lines.every((l) => l.x === lines[0].x), 'left-aligned');
  // The round caps of the 1.75 stroke reach half the stroke beyond each end; coordinates are 0.5 px-aligned.
  const cap = 1.75 / 2;
  for (const l of lines) {
    assert.ok(l.x - cap >= 2 && l.x + l.w + cap <= 22, `x of ${JSON.stringify(l)}`);
    assert.ok(l.y - cap >= 2 && l.y + cap <= 22, `y of ${JSON.stringify(l)}`);
    for (const v of [l.x, l.y, l.w]) assert.equal((v * 2) % 1, 0, `${v} is 0.5 px aligned`);
  }
});
