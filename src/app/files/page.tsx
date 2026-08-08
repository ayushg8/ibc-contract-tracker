'use client';

/**
 * Her contracts folder, as it is on disk.
 *
 * Two things this screen has to get right. It shows the FILESYSTEM, not the
 * database, so anything she moved in Finder shows up here rather than being
 * quietly contradicted. And nothing it can do is destructive: it makes folders,
 * it moves contract folders between them, and it opens things in Finder. There
 * is no delete and no rename of a contract, because Finder already does both and
 * an accidental one here costs a signed agreement.
 *
 * Rearranging is always two steps -- propose, then apply -- so she reads what
 * would happen before it happens. That is the same rule the review screen runs
 * on, and it is the reason a model is allowed anywhere near this at all.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  FileText,
  FolderOpen,
  FolderPlus,
  Sparkle,
} from '@phosphor-icons/react';

import { Button, Card, Input, SectionHeader, Spinner, useToast } from '@/components/ui';

interface TreeNode {
  name: string;
  path: string;
  kind: 'group' | 'contract' | 'file';
  children: TreeNode[];
  count: number;
}

interface PlannedMove {
  documentId: string;
  from: string;
  to: string;
  group: string | null;
}

type Scheme = 'year' | 'counterparty' | 'flat' | 'instruction';

const SCHEMES: { id: Scheme; label: string; blurb: string }[] = [
  { id: 'year', label: 'By year signed', blurb: 'A folder per year, from the effective date.' },
  { id: 'counterparty', label: 'By company', blurb: 'A folder per counterparty.' },
  { id: 'flat', label: 'All together', blurb: 'No groups. Every contract at the top level.' },
];

export default function FilesPage() {
  const { toast } = useToast();

  const [root, setRoot] = useState<string>('');
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const [plan, setPlan] = useState<PlannedMove[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [instruction, setInstruction] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/files');
      const body: unknown = await r.json();
      if (body !== null && typeof body === 'object') {
        const b = body as { root?: string; tree?: TreeNode };
        setRoot(b.root ?? '');
        setTree(b.tree ?? null);
      }
    } catch {
      toast({ title: 'Could not read the contracts folder', tone: 'bad' });
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reveal(path?: string): Promise<void> {
    // Whole-folder reveal takes no argument; the route opens the contracts root.
    await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(path === undefined ? {} : { path }),
    }).catch(() => undefined);
  }

  async function chooseRoot(): Promise<void> {
    try {
      const r = await fetch('/api/files/choose', { method: 'POST' });
      const b = (await r.json()) as { ok?: boolean; path?: string; cancelled?: boolean };
      if (b.cancelled === true) return;
      if (b.ok !== true || typeof b.path !== 'string') {
        toast({ title: 'No folder was chosen', tone: 'warn' });
        return;
      }
      const save = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archiveFolder: b.path }),
      });
      if (!save.ok) {
        toast({ title: 'That folder could not be used', tone: 'bad' });
        return;
      }
      toast({ title: 'Contracts folder changed', description: b.path, tone: 'ok' });
      await load();
    } catch {
      toast({ title: 'Could not open the folder chooser', tone: 'bad' });
    }
  }

  async function newFolder(): Promise<void> {
    const name = window.prompt('Name the new folder');
    if (name === null || name.trim() === '') return;
    const r = await fetch('/api/files/choose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', name }),
    });
    const b = (await r.json()) as { ok?: boolean; reason?: string };
    if (b.ok !== true) {
      toast({ title: 'The folder was not made', description: b.reason ?? '', tone: 'bad' });
      return;
    }
    await load();
  }

  async function propose(scheme: Scheme): Promise<void> {
    setPlanning(true);
    setPlan(null);
    try {
      const r = await fetch('/api/files/organize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          scheme === 'instruction' ? { scheme, instruction } : { scheme },
        ),
      });
      const b = (await r.json()) as { ok?: boolean; moves?: PlannedMove[]; reason?: string };
      if (b.ok !== true) {
        toast({ title: 'No arrangement to show', description: b.reason ?? '', tone: 'warn' });
        return;
      }
      setPlan(b.moves ?? []);
      if ((b.moves ?? []).length === 0) {
        toast({ title: 'Already arranged that way', description: 'Nothing would move.', tone: 'ok' });
      }
    } catch {
      toast({ title: 'That did not work', tone: 'bad' });
    } finally {
      setPlanning(false);
    }
  }

  async function apply(): Promise<void> {
    if (plan === null || plan.length === 0) return;
    setApplying(true);
    try {
      const r = await fetch('/api/files/organize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply: plan }),
      });
      const b = (await r.json()) as { moved?: number; refused?: number };
      const moved = b.moved ?? 0;
      const refused = b.refused ?? 0;
      toast({
        title: `${moved} ${moved === 1 ? 'contract' : 'contracts'} moved`,
        description: refused > 0 ? `${refused} were left where they were.` : undefined,
        tone: refused > 0 ? 'warn' : 'ok',
      });
      setPlan(null);
      await load();
    } catch {
      toast({ title: 'Nothing was moved', tone: 'bad' });
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="hairline-b flex shrink-0 items-center gap-[10px] px-[16px] py-[10px]">
        <span className="flex-1 truncate text-title-3 font-medium text-label">Files</span>
        <Button size="sm" icon={<FolderOpen size={12} />} onClick={() => void reveal()}>
          Open in Finder
        </Button>
        <Button size="sm" variant="ghost" icon={<FolderPlus size={12} />} onClick={() => void newFolder()}>
          New folder
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void chooseRoot()}>
          Change folder
        </Button>
        <Button size="sm" variant="ghost" icon={<ArrowsClockwise size={12} />} onClick={() => void load()}>
          Refresh
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-[16px] py-[14px]">
        <p className="mb-[12px] truncate font-mono text-footnote text-label-tertiary" title={root}>
          {root}
        </p>

        {/* ------------------------------ arrange ----------------------------- */}
        <Card padding="md" className="mb-[16px]">
          <SectionHeader title="Arrange them" />
          <p className="mt-[2px] text-footnote text-label-tertiary">
            Nothing moves until you press Apply.
          </p>

          <div className="mt-[10px] flex flex-wrap gap-[8px]">
            {SCHEMES.map((s) => (
              <Button key={s.id} size="sm" disabled={planning} onClick={() => void propose(s.id)} title={s.blurb}>
                {s.label}
              </Button>
            ))}
          </div>

          <div className="mt-[10px] flex items-center gap-[8px]">
            <Input
              value={instruction}
              placeholder="Or say how you want them filed…"
              aria-label="How to arrange the contracts"
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                void propose('instruction');
              }}
            />
            <Button
              size="sm"
              icon={<Sparkle size={12} />}
              loading={planning}
              disabled={instruction.trim() === ''}
              onClick={() => void propose('instruction')}
            >
              Propose
            </Button>
          </div>

          {plan !== null && plan.length > 0 && (
            <div className="mt-[12px]">
              <p className="text-callout font-medium text-label">
                {plan.length} {plan.length === 1 ? 'contract would move' : 'contracts would move'}
              </p>
              <ul className="mt-[6px] max-h-[220px] overflow-y-auto">
                {plan.map((m) => (
                  <li key={m.documentId} className="py-[3px] font-mono text-footnote text-label-secondary">
                    <span className="text-label-tertiary">{shortName(m.from)}</span>
                    {'  →  '}
                    <span className="text-label">{m.group === null ? 'top level' : m.group}/</span>
                    {shortName(m.to)}
                  </li>
                ))}
              </ul>
              <div className="mt-[10px] flex gap-[8px]">
                <Button size="sm" variant="primary" loading={applying} onClick={() => void apply()}>
                  Apply
                </Button>
                <Button size="sm" variant="ghost" disabled={applying} onClick={() => setPlan(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* ------------------------------- tree ------------------------------- */}
        {loading ? (
          <div className="flex items-center gap-[8px] text-callout text-label-tertiary">
            <Spinner size={12} /> Reading the folder…
          </div>
        ) : tree === null || tree.children.length === 0 ? (
          <p className="text-callout text-label-tertiary">
            Nothing here yet. Approved contracts appear as folders.
          </p>
        ) : (
          <Card padding="md">
            <Row node={tree} depth={0} open={open} setOpen={setOpen} onReveal={reveal} isRoot />
          </Card>
        )}
      </div>
    </div>
  );
}

function shortName(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

/**
 * One row, and its children.
 *
 * The indent lines are a real border on a padded container rather than drawn
 * characters, so they stay put when a name wraps.
 */
function Row({
  node,
  depth,
  open,
  setOpen,
  onReveal,
  isRoot = false,
}: {
  node: TreeNode;
  depth: number;
  open: Record<string, boolean>;
  setOpen: (f: (o: Record<string, boolean>) => Record<string, boolean>) => void;
  onReveal: (path?: string) => Promise<void>;
  isRoot?: boolean;
}) {
  const expandable = node.children.length > 0;
  // Groups and the root start open; a contract's own files start closed, so the
  // first thing she sees is the shape of her filing rather than every filename.
  const isOpen = open[node.path] ?? (isRoot || node.kind === 'group');

  const children = (
    <div className="ml-[9px] border-l-[0.5px] border-separator pl-[11px]">
      {node.children.map((c) => (
        <Row key={c.path} node={c} depth={depth + 1} open={open} setOpen={setOpen} onReveal={onReveal} />
      ))}
    </div>
  );

  if (isRoot) return <div>{children}</div>;

  return (
    <div>
      <div className="group flex items-center gap-[6px] py-[3px]">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-[6px] text-left"
          onClick={() => {
            if (expandable) setOpen((o) => ({ ...o, [node.path]: !isOpen }));
          }}
        >
          {expandable ? (
            isOpen ? (
              <CaretDown size={11} className="shrink-0 text-label-tertiary" />
            ) : (
              <CaretRight size={11} className="shrink-0 text-label-tertiary" />
            )
          ) : (
            <span className="w-[11px] shrink-0" />
          )}

          {node.kind === 'file' ? (
            <FileText size={13} className="shrink-0 text-label-tertiary" />
          ) : (
            <FolderOpen size={13} className="shrink-0 text-accent" />
          )}

          <span
            className={
              node.kind === 'file'
                ? 'truncate text-footnote text-label-secondary'
                : 'truncate text-callout text-label'
            }
            title={node.name}
          >
            {node.name}
          </span>

          {node.kind === 'group' && (
            <span className="tabular shrink-0 text-footnote text-label-tertiary">
              {node.count} {node.count === 1 ? 'contract' : 'contracts'}
            </span>
          )}
        </button>

        {node.kind !== 'file' && (
          <button
            type="button"
            className="shrink-0 text-footnote text-label-tertiary opacity-0 transition-opacity group-hover:opacity-100"
            onClick={() => void onReveal(node.path)}
          >
            Open
          </button>
        )}
      </div>

      {isOpen && expandable && children}
    </div>
  );
}
