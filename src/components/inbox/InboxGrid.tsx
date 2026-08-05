'use client';

import { AnimatePresence, motion } from 'motion/react';
import { SPRING_SNAPPY } from '@/components/ui';
import type { DocumentSummary } from '@/lib/db/types';
import { DocumentCard, type CardSelection } from './DocumentCard';

export interface InboxGridProps {
  documents: DocumentSummary[];
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  onOpenSettings: () => void;
  onReopen?: (id: string) => void;
  /** Omitted on a tab where nothing can be selected. */
  selectionFor?: (doc: DocumentSummary) => CardSelection;
  selectionActive?: boolean;
  onToggleSelect?: (id: string, opts: { range: boolean }) => void;
  busyIds?: ReadonlySet<string>;
}

export function InboxGrid({
  documents,
  onOpen,
  onRetry,
  onOpenSettings,
  onReopen,
  selectionFor,
  selectionActive,
  onToggleSelect,
  busyIds,
}: InboxGridProps) {
  return (
    <ul className="grid list-none grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-3">
      <AnimatePresence initial={false}>
        {documents.map((doc) => (
          <motion.li
            key={doc.id}
            layout
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={SPRING_SNAPPY}
          >
            <DocumentCard
              doc={doc}
              onOpen={onOpen}
              onRetry={onRetry}
              onOpenSettings={onOpenSettings}
              onReopen={onReopen}
              selection={selectionFor?.(doc)}
              selectionActive={selectionActive}
              onToggleSelect={onToggleSelect}
              busy={busyIds?.has(doc.id)}
            />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
