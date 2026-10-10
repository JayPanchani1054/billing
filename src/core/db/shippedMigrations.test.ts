/**
 * Shipped migrations never change: a company database records only its PRAGMA user_version, so a
 * migration that has already run on someone's computer is never run again there, while a database
 * still below that version runs whatever text the current build carries. Any edit to a shipped
 * migration therefore makes two installations with the "same" schema version differ. This test pins
 * the SQL of every shipped migration (sha256 of `sql`). A NEW migration gets a NEW version and its
 * own row here; an existing row must never be edited.
 *
 * Version 190 pins the text after the product rename, where only the product name in the suffix given
 * to a clashing predefined voucher type ("<name> (<product>)") changed; every other row is the text
 * these migrations shipped with.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { migrations } from './migrations/index.ts';

const SHIPPED: ReadonlyArray<readonly [number, string]> = [
[1, 'f71e18246494ed2d68754bd4a90258f90d6ddeb319c56b28243559810b4f52b3'],
[10, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
[20, '4d395bce9048d5fe73fb82efc4dfb403bc0e14eae586754508fe6b27ca1adf15'],
[30, 'e6a133a5324677ace0bd88c9365ba71081839fad3e3765f2076cf1829537ed72'],
[40, '4ae566f991efa954b23231ad3f66aa13c2d9c6c823d7f3e1aaffbb3d581b083f'],
[50, '04f2efc328c4703449bbc22a46258b61d66a67f2d8fddf4578a19e0a8cb213ca'],
[60, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
[70, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
[80, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
[90, '5137544015ec625429940de0efaecc744f986008872d5007c6cd71ac744d9455'],
[100, 'a10188360a70aa0a3b03d255261c62fe9b379f7238ce681c689a1c5a5a7d809a'],
[110, '1210891cdc3dc9181d6cc7abf6641d42fceba0ca9e65b8f47d3253ea5b7acb2d'],
[120, '57fd8e816e1e5e36b6d1755db14431f4f1490688002c0d7ec43558995edd9ad9'],
[130, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
[140, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
[150, '58c1fd953185925392762b2e73b84e20cb1f45821d9f16c6d4c94f9d12d91b51'],
[160, 'dc215172200d7e5cabea34b8f47b42d44b399ac3c1276b14078950c2e419fdb3'],
[161, 'ca17dc756c4d4f4ce332c562c7cc91537b7c2014aad5fa520e96e6491a74e5b9'],
[170, '1e5e34ad43cb2bdb9153ae657ce87b55853c9a657867097af06f189c70987c93'],
[180, '3139ee230026cd30113e5409b995309102b2c3173095dcf848e163333ed58634'],
[190, '28fce2890d04d9f3a369bb1fa9255e0b216ee6e60cf6d91fbb870da90b9e01b8'],
[191, '8aa36ba70ec58c4deeb13125f057e211bc1c5d9fbc01ecc3570b4455f2c6147f'],
[192, '99276fb170c36cbdb3fc849c2f7886d8faa5bfb38581ffcdb37326db3ce4e010'],
[193, 'e118dfc229f2e38f18f5a20a21149472b1f7c4ed66884ffe9ab7c60a5c9c5fff'],
[200, '30d22ae4d57f195db310415611009f4fc2bf45d22bb20227d13d34b2a37d434d'],
[210, '501ce9bb4924ef8db2a2497975577b741fc671e42ecdb630d9084ea494c7248b'],
[220, 'b1defe88b26e74a8ec6303e5b3dcf538079251ce5f52be01b02aa36aa9247722'],
[221, 'aca3537fac0d59c96dd394c28dafbd9baa9b2456b99d67e0cfa8dba63504ce82'],
[222, '2863a3a2d74b07606d3b1e882dadb6cc145985bb79eba92e8392f51e7b526c8b'],
[230, '24dc2eec52ed3d3a29f32844c474144a3073a94371764143dfe6cadc5125d3b9'],
[240, '3d6d73e12915bbcd229747bb82b36555a1de3c97ad92d0ea2c4e96f8923fe74c'],
[241, '8ada8a5b2c4cf40de6086c8f257cf95e6c4fe4990cd8e71c6ae8d8a35c6d7f90'],
[250, '61426fcdfdc1785e4f7d5f6808651e37cc13d93e3a3a128c508ddd993cb9863d'],
];

describe('shipped migrations', () => {
  it('keep their exact SQL text (sha256 pinned per version)', () => {
    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    for (const [version, sha] of SHIPPED) {
      const m = byVersion.get(version);
      assert.ok(m, `migration ${version} is missing`);
      assert.equal(createHash('sha256').update(m.sql).digest('hex'), sha, `migration ${version} (${m.name}) was edited after it shipped`);
    }
  });

  it('every migration in the list is pinned (add a row for a new version; never edit a row)', () => {
    const pinned = new Set(SHIPPED.map(([v]) => v));
    assert.deepEqual(migrations.map((m) => m.version).filter((v) => !pinned.has(v)), []);
  });
});
