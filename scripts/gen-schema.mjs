// Regenerates src/lib/db/schema.ts from schema.sql. Run after editing the SQL.
import fs from 'node:fs';
const sql = fs.readFileSync('src/lib/db/schema.sql', 'utf8');
if (sql.includes('`') || sql.includes('${')) {
  throw new Error('schema.sql contains template-literal characters; escape them first');
}
const header = `/**
 * The schema, as a bundled string. Generated from schema.sql -- do not edit by hand.
 * Regenerate with: node scripts/gen-schema.mjs
 */

export const SCHEMA_SQL = \``;
fs.writeFileSync('src/lib/db/schema.ts', header + sql + '`;\n');
console.log('src/lib/db/schema.ts regenerated');
