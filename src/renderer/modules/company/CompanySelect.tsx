/**
 * Company list (no company open): search, open (Enter), create (Alt+C), delete (Ctrl+D), data
 * folder with "Change…", restore a backup (Alt+R, data module dialog), data-folder problems, and a
 * first-company empty state.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompanyListItem } from '../../../shared/types/app.ts';
import { api } from '../../app/api.ts';
import { formatBytes, formatRelative } from '../../app/display.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useAppState } from '../../app/state.tsx';
import { Badge, Banner, Button, DataTable, EmptyState, Icon, Kbd, Spinner, TextInput, Tooltip, VisuallyHidden, filterAndRank, useHotkeys, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { CreateCompanyWizard } from './CreateCompanyWizard.tsx';
import { DataFolderDialog } from './DataFolderDialog.tsx';
import { DeleteCompanyDialog } from './DeleteCompanyDialog.tsx';
import { RestoreBackupDialog } from '../data/RestoreFlow.tsx';
import { GateLayout } from './GateLayout.tsx';

export function CompanySelect() {
  const [mode, setMode] = useState<'list' | 'create'>('list');
  if (mode === 'create') return <CreateCompanyWizard onCancel={() => setMode('list')} />;
  return <CompanyList onCreate={() => setMode('create')} />;
}

function sortCompanies(list: readonly CompanyListItem[]): CompanyListItem[] {
  return [...list].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || a.name.localeCompare(b.name, 'en-IN'));
}

function CompanyList({ onCreate }: { onCreate: () => void }) {
  const app = useAppState();
  const toast = useToast();
  const state = app.state;
  const companies = useMemo(() => sortCompanies(state?.companies ?? []), [state?.companies]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(companies[0]?.id ?? null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [deleting, setDeleting] = useState<CompanyListItem | null>(null);
  const [restoring, setRestoring] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLTableElement | null>(null);

  const rows = useMemo(
    () => filterAndRank(companies, query, (c) => ({ label: c.name, keywords: [c.gstin ?? '', c.fyLabel] })).map((r) => r.item),
    [companies, query],
  );

  useEffect(() => {
    if (!rows.some((r) => r.id === selected)) setSelected(rows[0]?.id ?? null);
  }, [rows, selected]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const open = async (c: CompanyListItem | undefined) => {
    if (!c || opening) return;
    if (c.needsUpgrade) {
      // The server upgrades on open when it can; tell the user what is happening.
      toast.info('Updating the company data', { message: 'This company was made with an older version of Bahi. It will be updated as it opens.' });
    }
    setOpening(c.id);
    setError(null);
    try {
      app.applyState(await api('app.company.open', { id: c.id }));
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setOpening(null);
    }
  };

  const selectedCompany = rows.find((r) => r.id === selected);

  useHotkeys(
    {
      'Alt+C': () => onCreate(),
      'Alt+R': () => setRestoring(true),
      'Ctrl+D': () => {
        if (selectedCompany) setDeleting(selectedCompany);
      },
    },
    [selectedCompany],
  );

  const columns = useMemo<Column<CompanyListItem>[]>(
    () => [
      {
        key: 'name',
        header: 'Company',
        sortable: true,
        render: (c) => (
          <span className="bx-company-cell">
            <span className="bx-company-cell__name">{c.name}</span>
            {c.securityEnabled ? (
              <Tooltip content="Password protected">
                <span className="bx-company-cell__lock" tabIndex={-1}>
                  <Icon name="lock" size="xs" />
                  <VisuallyHidden>(password protected)</VisuallyHidden>
                </span>
              </Tooltip>
            ) : null}
            {c.needsUpgrade ? (
              <Badge tone="warning" size="sm">
                Needs update
              </Badge>
            ) : null}
            {opening === c.id ? <Spinner size="xs" label="Opening" /> : null}
          </span>
        ),
      },
      { key: 'gstin', header: 'GSTIN', width: 180, value: (c) => c.gstin ?? '', render: (c) => (c.gstin ? <span className="bx-mono">{c.gstin}</span> : <span className="bx-muted">Not registered</span>) },
      { key: 'fyLabel', header: 'Year', width: 96 },
      {
        key: 'lastOpenedAt',
        header: 'Last opened',
        width: 150,
        sortable: true,
        sortValue: (c) => c.lastOpenedAt ?? '',
        render: (c) => (c.lastOpenedAt ? formatRelative(c.lastOpenedAt) : <span className="bx-muted">Never</span>),
      },
      { key: 'sizeBytes', header: 'Size', width: 90, align: 'right', sortable: true, render: (c) => <span className="bx-num">{formatBytes(c.sizeBytes)}</span> },
    ],
    [opening],
  );

  const folder = (
    <span className="bx-gate__folder">
      <Icon name="folder" size="sm" />
      <span className="bx-truncate" title={state?.dataDir}>
        {state?.dataDir}
      </span>
      <Button variant="ghost" size="sm" onClick={() => setFolderOpen(true)}>
        Change…
      </Button>
    </span>
  );

  const empty = companies.length === 0;

  return (
    <GateLayout
      title={empty ? 'Welcome to Bahi ERP' : 'Select a Company'}
      subtitle={empty ? undefined : 'Open a company to start working. Press Enter to open the highlighted one.'}
      width="wide"
      aside={folder}
      footer={
        <span className="bx-gate__keys">
          <Kbd keys="Enter" size="sm" tone="subtle" /> Open <Kbd keys="Alt+C" size="sm" tone="subtle" /> Create <Kbd keys="Alt+R" size="sm" tone="subtle" /> Restore <Kbd keys="Ctrl+D" size="sm" tone="subtle" /> Delete
          <span className="bx-muted"> · Version {state?.appVersion}</span>
        </span>
      }
    >
      {state?.dataDirError ? (
        <Banner
          tone="warning"
          title="Your data folder can't be read right now"
          action={
            <>
              <Button size="sm" onClick={() => void app.refresh()}>
                Try again
              </Button>
              <Button size="sm" onClick={() => setFolderOpen(true)}>
                Change folder…
              </Button>
            </>
          }
        >
          {state.dataDirError}
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="danger" title="The company could not be opened" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}

      {empty ? (
        <EmptyState
          size="lg"
          icon="building"
          title="Create your first company"
          body="Set up your business in about two minutes — name, GST details and financial year. You can change everything later."
          action={
            <>
              <Button variant="primary" icon="plus" onClick={onCreate} shortcut="Alt+C" autoFocus>
                Create company
              </Button>
              <Button icon="undo" onClick={() => setRestoring(true)} shortcut="Alt+R">
                Restore a backup…
              </Button>
            </>
          }
        />
      ) : (
        <div className="bx-company-list">
          <div className="bx-company-list__toolbar">
            <TextInput
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              leadingIcon="search"
              placeholder="Search by name or GSTIN"
              aria-label="Search companies"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  gridRef.current?.focus();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  void open(selectedCompany ?? rows[0]);
                }
              }}
            />
            <Button variant="primary" icon="plus" onClick={onCreate} shortcut="Alt+C">
              Create company
            </Button>
            <Button icon="undo" onClick={() => setRestoring(true)} shortcut="Alt+R">
              Restore a backup…
            </Button>
            <Button icon="trash" variant="ghost" disabled={!selectedCompany} onClick={() => selectedCompany && setDeleting(selectedCompany)} shortcut="Ctrl+D">
              Delete
            </Button>
          </div>
          <DataTable<CompanyListItem>
            aria-label="Companies"
            columns={columns}
            rows={rows}
            getRowKey={(c) => c.id}
            selectedKey={selected}
            onSelect={(k) => setSelected(k)}
            onRowActivate={(c) => void open(c)}
            gridRef={gridRef}
            empty={<EmptyState size="sm" icon="search" title="No company matches your search" body="Check the spelling, or clear the search box." />}
            height="min(60vh, 520px)"
          />
        </div>
      )}

      {folderOpen ? <DataFolderDialog onClose={() => setFolderOpen(false)} /> : null}
      {restoring ? <RestoreBackupDialog onClose={() => setRestoring(false)} /> : null}
      {deleting ? (
        <DeleteCompanyDialog
          company={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            toast.success(`${deleting.name} was deleted`, { message: 'Its file was moved to the trash folder inside your data folder.' });
            setDeleting(null);
            void app.refresh();
          }}
        />
      ) : null}
    </GateLayout>
  );
}
