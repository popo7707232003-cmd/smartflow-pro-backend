// src/db/migrate.ts
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { config } from '../config/index';

async function migrate() {
  const pool = new pg.Pool({ connectionString: config.database.url });

  console.log('Running migrations...');

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    console.log(`  Executing: ${file}`);
    try {
      await pool.query(sql);
      console.log(`  ✓ ${file} complete`);
    } catch (err) {
      console.error(`  ✗ ${file} failed:`, (err as Error).message);
      throw err;
    }
  }

  console.log('All migrations complete');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
