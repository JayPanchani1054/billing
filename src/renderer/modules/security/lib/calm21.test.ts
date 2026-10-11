/**
 * 2.1 "calm" (SPEC-21 WP-L2): the data, security and attachments screens are on the one template — read
 * from source, so a later edit cannot quietly bring back a second Save, a footer bar, a filled Create on a
 * list, a checkbox view option or the numbered wizard discs. Keys are untouched (keyConventions.test.ts).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const read = (rel: string): string => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
/** The JSX of every `<Screen …>` opening tag in a file (up to the `>` that closes it at brace depth 0). */
function screenTags(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<(?:Screen|ReportScreen)\b/g)) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0 && src[i - 1] !== '=') break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

const SCREENS = [
  'data/BackupScreen.tsx',
  'data/ExportScreen.tsx',
  'data/ImportScreen.tsx',
  'data/RestoreFlow.tsx',
  'data/VerifyScreen.tsx',
  'data/XmlExportScreen.tsx',
  'data/XmlImportScreen.tsx',
  'security/AuditScreen.tsx',
  'security/RoleFormScreen.tsx',
  'security/SecuritySettingsScreen.tsx',
  'security/SessionScreen.tsx',
  'security/UsersRolesScreen.tsx',
  'attachments/AttachmentsScreens.tsx',
];

describe('2.1 calm template: data, security, attachments', () => {
  it('no page screen has a footer bar or an icon tile; Save lives only in the title row', () => {
    for (const f of SCREENS) {
      for (const tag of screenTags(read(f))) {
        assert.doesNotMatch(tag, /\sfooter=/, `${f}: a <Screen footer> repeats the title row's primary`);
        assert.doesNotMatch(tag, /\sicon="/, `${f}: no icon beside the title`);
      }
    }
  });

  it('page screens draw no filled button of their own (dialogs keep theirs)', () => {
    for (const f of ['data/ExportScreen.tsx', 'data/ImportScreen.tsx', 'data/XmlImportScreen.tsx', 'data/XmlExportScreen.tsx', 'security/SecuritySettingsScreen.tsx', 'security/SessionScreen.tsx', 'security/UsersRolesScreen.tsx', 'attachments/AttachmentsScreens.tsx']) {
      assert.doesNotMatch(read(f), /variant="primary"/, `${f}: the only filled button is the title row's primary`);
    }
  });

  it('lists have no filled Create (D5): Users, Roles, Attachments, Edit Log', () => {
    for (const f of ['security/UsersRolesScreen.tsx', 'attachments/AttachmentsScreens.tsx', 'security/AuditScreen.tsx']) {
      assert.doesNotMatch(read(f), /primary: true/, f);
    }
  });

  it('"Show deactivated users" is a keyless checkable More item, not a checkbox on screen', () => {
    const src = read('security/UsersRolesScreen.tsx');
    assert.match(src, /\{ key: NO_KEY, label: 'Show deactivated users', onClick: [^\n]+, checked: showInactive, group: 'view' \}/);
    assert.doesNotMatch(src, /<Checkbox/);
  });

  it('the Edit Log keeps one search and one Filters ▾ in a toolbar row', () => {
    const src = read('security/AuditScreen.tsx');
    assert.match(src, /className="bx-toolbar-row" role="search" aria-label="Filter the edit log"/);
    assert.match(src, /<FiltersPopover count=\{activeFilterCount\(filters\)\} onClear=\{clearFilters\}>/);
  });

  it('Backup and Restore keep a filled button only inside their dialogs (Check backup, Restore a backup)', () => {
    for (const f of ['data/BackupScreen.tsx', 'data/RestoreFlow.tsx']) {
      const src = read(f);
      const filled = [...src.matchAll(/variant="primary"/g)];
      assert.ok(filled.length > 0, `${f}: its dialog keeps its primary`);
      for (const m of filled) {
        // The nearest opening tag of a container before the button must be a <Modal>, not the page's <Screen>.
        const before = src.slice(0, m.index);
        const modal = before.lastIndexOf('<Modal');
        const page = Math.max(before.lastIndexOf('<Screen'), before.lastIndexOf('<ReportScreen'));
        assert.ok(modal > page, `${f}: a filled button outside a dialog repeats the title row's primary`);
      }
    }
  });

  it('a checkbox explanation is a focus hint (field message + aria-describedby), not a second line', () => {
    const src = read('data/components.tsx');
    const tip = src.slice(src.indexOf('export function TipCheckbox'), src.indexOf('// ─', src.indexOf('export function TipCheckbox')));
    assert.match(tip, /<Checkbox \{\.\.\.props\} aria-describedby=\{hintId\} \/>/);
    assert.match(tip, /<p className="bx-field__message" id=\{hintId\}>/);
    assert.match(tip, /<div className="bx-field" title=\{tip\}>/);
    assert.doesNotMatch(tip, /description=/);
    for (const f of ['data/ExportScreen.tsx', 'data/ImportScreen.tsx', 'data/XmlExportScreen.tsx', 'data/XmlImportScreen.tsx']) {
      assert.doesNotMatch(read(f), /<Checkbox[^>]*\sdescription=/, `${f}: use TipCheckbox for an explained checkbox`);
    }
  });

  it('an action a banner offers is not also a title-row button (My Session: Change password)', () => {
    const src = read('security/SessionScreen.tsx');
    assert.match(src, /key: 'Alt\+W', label: 'Change password', [^\n]*onClick: [^\n]*demoted: pwdBanner \}/);
    // The same condition shows the banner (with its Change password link).
    assert.match(src, /const pwdBanner = !!pwd && \(pwd\.tone === 'warning' \|\| pwd\.tone === 'danger'\);/);
    assert.match(src, /\{pwd && \(pwd\.tone === 'warning' \|\| pwd\.tone === 'danger'\) \? \(\s*<Banner[\s\S]{0,400}?Change password/);
  });

  it('Enter still chooses the file on the wizards\' first step (2.0 focused an in-page button for it)', () => {
    assert.match(read('data/ImportScreen.tsx'), /useEnterRunsStep\(\(\) => void pickFile\(\), step === 'file' && busy === null\);/);
    assert.match(read('data/XmlImportScreen.tsx'), /useEnterRunsStep\(\(\) => void pick\(\), step === 'file' && busy === null\);/);
    assert.match(read('data/RestoreFlow.tsx'), /useEnterRunsStep\(\(\) => flow\.primary\?\.run\(\), flow\.step === 'choose' && !busy\);/);
    const hook = read('data/components.tsx');
    assert.match(hook, /export function useEnterRunsStep[\s\S]*?Enter: \(e\) => \{\s*if \(!enterRunsStep\(/);
  });

  it('states are words; a badge marks only an exception (D5/§2.3 Badge)', () => {
    for (const f of ['data/BackupScreen.tsx', 'data/components.tsx', 'data/VerifyScreen.tsx', 'attachments/AttachmentsScreens.tsx', 'security/components.tsx', 'security/AuditScreen.tsx', 'security/UsersRolesScreen.tsx', 'security/SessionScreen.tsx', 'security/RoleFormScreen.tsx']) {
      for (const m of read(f).matchAll(/<Badge\b[^>]*>/g)) assert.match(m[0], /tone="danger"/, `${f}: ${m[0]}`);
    }
    // The import preview: "Ready" / "Exists" are words; a row to check or fix keeps its badge.
    assert.match(read('data/ImportScreen.tsx'), /return b\.tone === 'danger' \|\| b\.tone === 'warning' \? \(\s*<Badge size="sm" tone=\{b\.tone\}>/);
  });

  it('the wizards say their step in the title row (no numbered discs)', () => {
    for (const f of ['data/ImportScreen.tsx', 'data/XmlImportScreen.tsx', 'data/RestoreFlow.tsx']) {
      const src = read(f);
      assert.match(src, /stepLine\(STEPS, /, f);
      assert.doesNotMatch(src, /<Steps\b/, f);
    }
  });
});
