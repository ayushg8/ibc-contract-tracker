/**
 * Writes Bonnie's workbook, not "a spreadsheet".
 *
 * She pastes this over her existing file, so the layout is copied from Tracker.xlsx:
 * company name on row 1, tracker title on row 2, blank row 3, headers on row 4, data
 * from row 5. Header text comes from FieldDef.excelHeader, which preserves oddities
 * like the two spaces in "Confidentiality  term".
 *
 * Termination is written as a live formula whenever the term is day-based, because her
 * Eval Agmt sheet does exactly that and she expects the cell to keep recalculating.
 */

// exceljs re-exports through another CJS module, so node's ESM lexer cannot see its
// named exports. The default import is the only form that works under both webpack
// and plain `node --experimental-strip-types`, which the eval harness uses.
import ExcelJS from 'exceljs';
import type { CellFormulaValue, Workbook } from 'exceljs';

import { listContractsForExport, markExported } from '@/lib/db/queries';
import type { ExportRow } from '@/lib/db/queries';
import {
  DOC_TYPE_SHEET,
  excelColumnsFor,
  type DocType,
  type FieldDef,
  type FieldKey,
  type FieldType,
} from '@/lib/fields';
import { log } from '@/lib/logger';
import { toEngineError } from '@/lib/providers/errors';
import { parseDateIso } from '@/lib/util/dates';

const COMPANY_ROW = 1;
const TITLE_ROW = 2;
const HEADER_ROW = 4;
const FIRST_DATA_ROW = 5;

const COMPANY = 'International Battery Company, Inc.';

/** Row 2 in her file. The NDA sheet is titled differently from the others. */
const TRACKER_TITLE: Record<DocType, string> = {
  nda: 'NDA Tracker',
  evaluation: 'Legal Contract Tracker',
  other: 'Legal Contract Tracker',
};

const DATE_FORMAT = 'mmmm d, yyyy';

const WIDTH_BY_TYPE: Record<FieldType, number> = {
  text: 26,
  longtext: 42,
  date: 18,
  duration: 20,
  email: 30,
  boolean: 12,
};

/**
 * Columns this sheet carries, in HER column order -- see EXCEL_COLUMN_ORDER. This used
 * to walk FIELD_LIST, which is grouped for the review screen and interleaves the party
 * fields differently; the exported sheet came out with six columns in the wrong places.
 */
function columnsFor(docType: DocType): FieldDef[] {
  return excelColumnsFor(docType);
}

function columnLetter(index1: number): string {
  let n = index1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * ExcelJS converts a JS Date to a serial number via UTC, so building the Date in UTC
 * is what keeps "November 5, 2022" from rendering as November 4 west of Greenwich.
 */
function toExcelDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const [, ys, ms, ds] = m;
  if (ys === undefined || ms === undefined || ds === undefined) return null;
  const y = Number(ys);
  const mo = Number(ms);
  const d = Number(ds);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** "90 days" -> formula. "5 years" -> literal date, because +N days would be a lie. */
function isDayBased(term: string | null): boolean {
  return term !== null && /\bdays?\b/i.test(term);
}

function valueMap(row: ExportRow): Map<FieldKey, string | null> {
  const map = new Map<FieldKey, string | null>();
  for (const f of row.fields) map.set(f.key, f.value);
  return map;
}

/**
 * A date cell, resolved from the CONTRACT row first and the evidence row second.
 *
 * The evidence row keeps what the reviewer actually typed -- "March 1, 2024" --
 * because Review has to show her her own words back. The normalised ISO value
 * lives on the contract, written by recomputeContractDerived, and is the
 * override-aware one. Reading only the evidence row meant toExcelDate() rejected
 * the text and wrote an EMPTY cell over exactly the dates a human had taken the
 * trouble to correct, in the file she pastes over her own workbook. A silently
 * blank cell is worse than a wrong one: nothing on screen says it happened.
 *
 * Both candidates go through parseDateIso rather than being trusted as ISO. A
 * manual termination override is stored verbatim on the contract too, so the
 * "normalised" column is only normalised when nobody has overridden it.
 */
function excelDate(contractValue: string | null, rawValue: string | null): Date | null {
  return toExcelDate(parseDateIso(contractValue)) ?? toExcelDate(parseDateIso(rawValue));
}

/** The normalised twin of a date column, or null for a date field that has none. */
function contractDateFor(key: FieldKey, row: ExportRow): string | null {
  if (key === 'effective_date') return row.contract.effectiveDate;
  if (key === 'termination_date') return row.contract.terminationDate;
  return null;
}

function buildSheet(wb: Workbook, docType: DocType, rows: ExportRow[]): void {
  const ws = wb.addWorksheet(DOC_TYPE_SHEET[docType]);
  const columns = columnsFor(docType);

  ws.getCell(COMPANY_ROW, 1).value = COMPANY;
  ws.getRow(COMPANY_ROW).font = { bold: true, size: 14 };
  ws.getCell(TITLE_ROW, 1).value = TRACKER_TITLE[docType];
  ws.getRow(TITLE_ROW).font = { bold: true, size: 12 };
  // Row 3 stays empty. She uses it as the visual break above the headers.

  columns.forEach((def, i) => {
    const col = i + 1;
    ws.getCell(HEADER_ROW, col).value = def.excelHeader;
    ws.getColumn(col).width = WIDTH_BY_TYPE[def.type];
  });
  ws.getRow(HEADER_ROW).font = { bold: true };

  const effectiveCol = columns.findIndex((c) => c.key === 'effective_date') + 1;

  rows.forEach((row, i) => {
    const rowNumber = FIRST_DATA_ROW + i;
    const values = valueMap(row);

    // Resolved once, so the termination formula anchors on the SAME effective date
    // the effective column writes rather than on a second reading of the evidence.
    const effective = excelDate(row.contract.effectiveDate, values.get('effective_date') ?? null);

    columns.forEach((def, colIndex) => {
      const cell = ws.getCell(rowNumber, colIndex + 1);
      const raw = values.get(def.key) ?? null;

      if (def.key === 'termination_date') {
        const literal = excelDate(row.contract.terminationDate, raw);
        const termDays = row.contract.termDays;
        const useFormula =
          // A human who typed the date owns it; a formula would overwrite their answer.
          !row.contract.terminationOverride &&
          termDays !== null &&
          isDayBased(values.get('term') ?? null) &&
          effectiveCol > 0 &&
          effective !== null;

        if (useFormula && termDays !== null) {
          const anchor = `${columnLetter(effectiveCol)}${rowNumber}`;
          const formula: CellFormulaValue = { formula: `${anchor}+${termDays}` };
          if (literal) formula.result = literal;
          cell.value = formula;
        } else {
          cell.value = literal;
        }
        cell.numFmt = DATE_FORMAT;
        return;
      }

      if (def.type === 'date') {
        cell.value = excelDate(contractDateFor(def.key, row), raw);
        cell.numFmt = DATE_FORMAT;
        return;
      }

      cell.value = raw;
    });
  });

  ws.views = [{ state: 'frozen', ySplit: HEADER_ROW }];
  if (columns.length > 0) {
    ws.autoFilter = {
      from: { row: HEADER_ROW, column: 1 },
      to: { row: HEADER_ROW, column: columns.length },
    };
  }
}

export function exportFilename(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `Tracker_${y}-${m}-${d}.xlsx`;
}

/** Row count per sheet, for the Export tab's preview. */
export function exportCounts(): Record<DocType, number> {
  const counts: Record<DocType, number> = { nda: 0, evaluation: 0, other: 0 };
  for (const row of listContractsForExport()) counts[row.contract.docType] += 1;
  return counts;
}

/**
 * Builds the workbook and records the export. Sheets are created for every requested
 * doc type even when empty, because her file always has both tabs.
 */
export async function exportWorkbook(docTypes: DocType[]): Promise<Buffer> {
  try {
    const all = listContractsForExport();

    const wb = new ExcelJS.Workbook();
    wb.creator = COMPANY;
    wb.created = new Date();

    const exported: string[] = [];
    for (const docType of docTypes) {
      const rows = all.filter((r) => r.contract.docType === docType);
      buildSheet(wb, docType, rows);
      for (const r of rows) exported.push(r.contract.id);
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    // Writes one 'exported' audit row per contract and stamps lastExportedAt.
    markExported(exported, { detail: `sheets: ${docTypes.join(', ')}` });

    log.info('export.written', {
      sheets: docTypes,
      contracts: exported.length,
      bytes: buffer.byteLength,
    });
    return buffer;
  } catch (e) {
    throw toEngineError(e);
  }
}
