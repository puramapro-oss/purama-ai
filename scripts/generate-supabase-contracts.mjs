import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Use the project's existing SQL test runtime; never connect to a remote database.
const require = createRequire(new URL('../karta/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const root = new URL('../', import.meta.url);
const output = new URL('src/integrations/supabase/schema-contracts.ts', root);
const sources = [
  'p3_schema.sql',
  'supabase/migrations/20260422180000_v4_1_stripe_connect_opentimestamps.sql',
];

const scalarTypes = new Map([
  ['uuid', 'string'], ['text', 'string'], ['varchar', 'string'],
  ['date', 'string'], ['timestamp', 'string'], ['timestamptz', 'string'],
  ['int2', 'number'], ['int4', 'number'], ['int8', 'number'],
  ['numeric', 'number'], ['float4', 'number'], ['float8', 'number'],
  ['bool', 'boolean'], ['json', 'Json'], ['jsonb', 'Json'],
]);

function typeFor(column) {
  const array = column.udt_name.startsWith('_');
  const name = array ? column.udt_name.slice(1) : column.udt_name;
  const type = scalarTypes.get(name);
  if (!type) throw new Error(`Unsupported PostgreSQL type ${column.udt_name}`);
  return `${type}${array ? '[]' : ''}${column.is_nullable === 'YES' ? ' | null' : ''}`;
}

async function schemaTables(db, schema) {
  const { rows: columns } = await db.query(`
    SELECT table_name, column_name, is_nullable, column_default, udt_name
    FROM information_schema.columns
    WHERE table_schema = $1
    ORDER BY table_name, ordinal_position
  `, [schema]);
  const { rows: relationships } = await db.query(`
    SELECT child.relname AS table_name, fk.conname AS name,
      array_agg(child_column.attname ORDER BY key.ordinality) AS columns,
      parent.relname AS referenced_table,
      array_agg(parent_column.attname ORDER BY key.ordinality) AS referenced_columns,
      EXISTS (
        SELECT 1 FROM pg_constraint unique_key
        WHERE unique_key.conrelid = fk.conrelid
          AND unique_key.contype IN ('p', 'u') AND unique_key.conkey = fk.conkey
      ) AS is_one_to_one
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace parent_schema ON parent_schema.oid = parent.relnamespace
    CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) WITH ORDINALITY AS key(child_number, parent_number, ordinality)
    JOIN pg_attribute child_column ON child_column.attrelid = child.oid AND child_column.attnum = key.child_number
    JOIN pg_attribute parent_column ON parent_column.attrelid = parent.oid AND parent_column.attnum = key.parent_number
    WHERE fk.contype = 'f' AND child_schema.nspname = $1 AND parent_schema.nspname = $1
    GROUP BY child.relname, fk.oid, fk.conname, parent.relname
    ORDER BY child.relname, fk.conname
  `, [schema]);

  const tables = Map.groupBy(columns, column => column.table_name);
  return [...tables].map(([name, fields]) => {
    const forms = ['Row', 'Insert', 'Update'].map(form => {
      const members = fields.map(column => {
        const optional = form === 'Update' || (form === 'Insert' &&
          (column.is_nullable === 'YES' || column.column_default !== null));
        return `      ${column.column_name}${optional ? '?' : ''}: ${typeFor(column)}`;
      });
      return `    ${form}: {\n${members.join('\n')}\n    }`;
    });
    const refs = relationships.filter(ref => ref.table_name === name).map(ref =>
      `      {\n        foreignKeyName: ${JSON.stringify(ref.name)}\n` +
      `        columns: ${JSON.stringify(ref.columns)}\n` +
      `        isOneToOne: ${ref.is_one_to_one}\n` +
      `        referencedRelation: ${JSON.stringify(ref.referenced_table)}\n` +
      `        referencedColumns: ${JSON.stringify(ref.referenced_columns)}\n      }`);
    forms.push(refs.length ? `    Relationships: [\n${refs.join(',\n')}\n    ]` : '    Relationships: []');
    return `  ${name}: {\n${forms.join('\n')}\n  }`;
  }).join('\n');
}

const db = new PGlite();
try {
  // auth is only a dependency fixture for foreign keys and RLS policy parsing.
  // It contains no users or credentials and is not part of the generated contract.
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE SCHEMA purama_ai;
  `);
  const provenance = [];
  for (const source of sources) {
    const sql = await readFile(new URL(source, root), 'utf8');
    await db.exec(sql);
    provenance.push(`// ${source} sha256:${createHash('sha256').update(sql).digest('hex')}`);
  }
  const generated = [
    '// Generated from versioned SQL by scripts/generate-supabase-contracts.mjs.',
    '// Rebuild: npm ci --prefix karta --ignore-scripts && node scripts/generate-supabase-contracts.mjs',
    '// Check: node scripts/generate-supabase-contracts.mjs --check',
    '// This is a local DDL contract, not an introspection or migration of the deployed database.',
    '// Auth-schema foreign keys are omitted because auth is not an exposed client schema.',
    ...provenance,
    'import type { Json } from "./types"',
    '',
    `export type P3Tables = {\n${await schemaTables(db, 'purama_ai')}\n}`,
    '',
    `export type PublicTables = {\n${await schemaTables(db, 'public')}\n}`,
    '',
  ].join('\n');
  if (process.argv.includes('--check')) {
    const current = await readFile(output, 'utf8');
    if (current !== generated) throw new Error('SQL contract is out of date; regenerate schema-contracts.ts');
    console.log('PASS: generated Supabase table contracts match the versioned SQL catalog.');
  } else {
    await writeFile(output, generated);
    console.log(`Generated ${fileURLToPath(output)} from the local PostgreSQL catalog.`);
  }
} finally {
  await db.close();
}
