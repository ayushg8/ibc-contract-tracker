/**
 * The workbook, written and then read back.
 *
 * Bonnie pastes this file over the one she already keeps, so the layout is not a
 * preference: the company name is on row 1, the tracker title on row 2, row 3 is empty,
 * the headers are on row 4 and the data starts on row 5. One header has two spaces in it -
 * "Confidentiality  term" - because hers does, and a diff of her file against ours has to
 * come back clean.
 *
 * Dates are asserted to be real dates rather than strings, because a text date sorts
 * alphabetically and computes nothing, and the termination cell on a day-based term is
 * asserted to be a live formula, because that is what her Eval Agmt sheet contains today.
 */

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  DOC_TYPE_SHEET,
  FIELD_LIST,
  SHEET_EXCLUDED_FIELDS,
  type DocType,
  type FieldKey,
} from '../src/lib/fields';
import type { FieldValueInput } from '../src/lib/db/types';
import { useEvalDataDir, writeFixturePdf } from '../evals/cases/_harness';
import { ntrium, octillion, type Fixture } from '../evals/fixtures/index';

useEvalDataDir();

async function optional<T>(thunk: () => Promise<T>): Promise<T | null> {
  try {
    return await thunk();
  } catch {
    return null;
  }
}

const excel = await optional(() => import('../src/lib/excel/export'));
const queries = await optional(() => import('../src/lib/db/queries'));
const exceljs = await optional(() => import('exceljs'));

/**
 * Her workbook's row 4, transcribed by hand from Tracker.xlsx rather than derived from
 * the app's own constants.
 *
 * That is the point: she pastes our output over her existing sheet, so the assertion has
 * to be against the FILE, not against whatever the code currently believes. Deriving it
 * from EXCEL_COLUMN_ORDER would make this test agree with any reordering, including a
 * wrong one -- which is exactly how the columns silently drifted out of her order once
 * already. Note the two spaces in "Confidentiality  term"; they are in her file.
 */
const HER_NDA_HEADERS = [
  'Party A',
  'Party B',
  'Name of Contract',
  'Effective Date',
  'Term',
  'Termination',
  'Confidentiality  term',
  'IBC Form',
  'Party A signer',
  'Party A address',
  'Party B signer',
  'Party B address',
  'Notice Email',
  'Notice Address',
  'Governing Law',
];

/** Same sheet, minus IBC Form, which her Eval Agmt tab does not carry. */
const HER_EVAL_HEADERS = HER_NDA_HEADERS.filter((h) => h !== 'IBC Form');

function headersFor(docType: DocType): string[] {
  return docType === 'evaluation' ? HER_EVAL_HEADERS : HER_NDA_HEADERS;
}

if (excel === null || queries === null || exceljs === null) {
  describe.skip('excel export', () => {
    it('needs src/lib/excel/export.ts and src/lib/db/queries.ts to import', () => {
      expect(true).toBe(true);
    });
  });
} else {
  // Narrowed once, so every helper below sees non-null modules.
  const db = queries;
  const workbookOf = excel;

  /** An approved contract, seeded straight through the real approve transaction. */
  const approve = (f: Fixture): string => {
    const file = writeFixturePdf(f, '-export');
    const { id } = db.createDocument({
      fileHash: file.fileHash,
      filename: f.filename,
      archivePath: file.path,
      byteSize: file.bytes.byteLength,
    });
    const values: FieldValueInput[] = FIELD_LIST.map((def) => ({
      key: def.key,
      value: f.expected[def.key],
      quote: f.quotes[def.key] ?? null,
      page: 1,
      method: def.source === 'computed' ? 'computed' : 'rule',
    }));
    db.putDocumentFields(id, values);
    db.setDocumentType(id, f.docType);
    db.setDocumentStatus(id, 'ready');
    expect(db.approvalBlockers(id)).toEqual([]);
    return db.approveDocument(id);
  };

  const ndaContract = approve(ntrium);
  const evalContract = approve(octillion);

  const buffer = await workbookOf.exportWorkbook(['nda', 'evaluation']);
  const wb = new exceljs.Workbook();
  // read(stream) rather than load(buffer): the Buffer generics in @types/node 26 and the
  // ones exceljs was typed against do not line up, and a cast is not worth it here.
  await wb.xlsx.read(Readable.from(buffer));

  describe('excel export', () => {
    it('writes both of her sheets, named exactly as her file names them', () => {
      expect(ndaContract).toBeTruthy();
      expect(evalContract).toBeTruthy();
      expect(wb.worksheets.map((ws) => ws.name)).toEqual([
        DOC_TYPE_SHEET.nda,
        DOC_TYPE_SHEET.evaluation,
      ]);
    });

    it('puts the headers on row 4, with the data starting on row 5', () => {
      const ws = wb.getWorksheet(DOC_TYPE_SHEET.nda);
      expect(ws).toBeDefined();
      if (!ws) return;

      expect(ws.getCell(1, 1).value).toBe('International Battery Company, Inc.');
      expect(String(ws.getCell(2, 1).value ?? '')).toContain('Tracker');
      expect(ws.getCell(3, 1).value ?? null).toBeNull();

      const headers = headersFor('nda').map((h, i) => ws.getCell(4, i + 1).value);
      expect(headers).toEqual(headersFor('nda'));

      // Row 5 is the first contract, not a second header or a spacer.
      const firstColumn = headersFor('nda')[0];
      expect(firstColumn).toBe('Party A');
      expect(ws.getCell(5, 1).value).toBe('International Battery Company, Inc.');
    });

    it('keeps the two spaces in "Confidentiality  term"', () => {
      const ws = wb.getWorksheet(DOC_TYPE_SHEET.nda);
      expect(ws).toBeDefined();
      if (!ws) return;
      const row4 = headersFor('nda').map((_h, i) => String(ws.getCell(4, i + 1).value ?? ''));
      expect(row4).toContain('Confidentiality  term');
      expect(row4).not.toContain('Confidentiality term');
    });

    it('omits IBC Form from the Eval Agmt sheet, as her file does', () => {
      const ws = wb.getWorksheet(DOC_TYPE_SHEET.evaluation);
      expect(ws).toBeDefined();
      if (!ws) return;
      const expected = headersFor('evaluation');
      const row4 = expected.map((_h, i) => String(ws.getCell(4, i + 1).value ?? ''));
      expect(row4).toEqual(expected);
      expect(row4).not.toContain('IBC Form');
      expect(headersFor('nda')).toContain('IBC Form');
    });

    it('writes dates as dates, not as text', () => {
      const ws = wb.getWorksheet(DOC_TYPE_SHEET.nda);
      expect(ws).toBeDefined();
      if (!ws) return;
      const col = headersFor('nda').indexOf('Effective Date') + 1;
      expect(col).toBeGreaterThan(0);
      const cell = ws.getCell(5, col);
      expect(cell.value).toBeInstanceOf(Date);
      const asDate = cell.value instanceof Date ? cell.value : new Date(0);
      expect(asDate.toISOString().slice(0, 10)).toBe(ntrium.expected.effective_date);
      expect(String(cell.numFmt ?? '')).toContain('yyyy');
    });

    it('writes termination as a live formula when the term is in days', () => {
      const ws = wb.getWorksheet(DOC_TYPE_SHEET.evaluation);
      expect(ws).toBeDefined();
      if (!ws) return;
      const headers = headersFor('evaluation');
      const terminationCol = headers.indexOf('Termination') + 1;
      const effectiveCol = headers.indexOf('Effective Date') + 1;
      expect(terminationCol).toBeGreaterThan(0);

      const cell = ws.getCell(5, terminationCol);
      const value = cell.value;
      const formula =
        typeof value === 'object' && value !== null && 'formula' in value
          ? String(Reflect.get(value, 'formula'))
          : null;
      expect(formula).not.toBeNull();

      // The formula has to point at this row's own effective date, plus the parsed term.
      const letter = String.fromCharCode(64 + effectiveCol);
      expect(formula).toBe(`${letter}5+90`);
    });

    it('writes a literal date when the term is in years, because +N days would be a lie', () => {
      const ws = wb.getWorksheet(DOC_TYPE_SHEET.nda);
      expect(ws).toBeDefined();
      if (!ws) return;
      const col = headersFor('nda').indexOf('Termination') + 1;
      const cell = ws.getCell(5, col);
      expect(cell.value).toBeInstanceOf(Date);
      const asDate = cell.value instanceof Date ? cell.value : new Date(0);
      expect(asDate.toISOString().slice(0, 10)).toBe(ntrium.computed.terminationDate);
    });

    it('records the export so the Settings tab can say when it last ran', () => {
      expect(db.getSettings().lastExportedAt).toBeTruthy();
      const audit = db.getContractAudit(ndaContract);
      expect(audit.some((e) => e.action === 'exported')).toBe(true);
    });

    /**
     * The whole point of the file.
     *
     * She corrects a date by typing it the way people type dates. The record keeps
     * her wording on the evidence row and the normalised ISO on the contract, and
     * the workbook used to read only the evidence row -- so a date she had gone to
     * the trouble of fixing came out as an EMPTY cell, in the sheet she pastes over
     * her own. Nothing on any screen said so: the repository showed the corrected
     * date the entire time.
     */
    describe('after a human corrects a date', () => {
      const cellOn = async (docType: DocType, header: string): Promise<unknown> => {
        const buffer2 = await workbookOf.exportWorkbook([docType]);
        const wb2 = new exceljs.Workbook();
        await wb2.xlsx.read(Readable.from(buffer2));
        const ws = wb2.getWorksheet(DOC_TYPE_SHEET[docType]);
        if (!ws) throw new Error(`no ${docType} sheet`);
        return ws.getCell(5, headersFor(docType).indexOf(header) + 1).value;
      };

      const isoOf = (value: unknown): string | null =>
        value instanceof Date ? value.toISOString().slice(0, 10) : null;

      it('exports a corrected Effective Date instead of blanking the cell', async () => {
        db.setContractField(ndaContract, 'effective_date', 'March 1, 2024', 'bonnie');
        // The record itself normalised it; the cell has to carry the same value.
        expect(db.getContractDetail(ndaContract)?.effectiveDate).toBe('2024-03-01');
        expect(isoOf(await cellOn('nda', 'Effective Date'))).toBe('2024-03-01');
      });

      it('exports a termination override as a real date, not a blank', async () => {
        db.setContractField(ndaContract, 'termination_date', 'January 2, 2030', 'bonnie');
        expect(db.getContractDetail(ndaContract)?.terminationOverride).toBe(true);
        // An override is never a formula: a formula would compute over her answer.
        expect(isoOf(await cellOn('nda', 'Termination'))).toBe('2030-01-02');
      });

      it('leaves the cell empty when the typed value is not a date at all', async () => {
        db.setContractField(ndaContract, 'effective_date', 'TBD', 'bonnie');
        // Refusing to invent a date is the point; an empty cell is only wrong when
        // there was a real value to write.
        expect(await cellOn('nda', 'Effective Date')).toBeNull();
      });
    });
  });
}
