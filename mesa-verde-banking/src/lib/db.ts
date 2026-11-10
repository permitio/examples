import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databasePath } from '@/lib/env';

let database: DatabaseSync | undefined;

/** Opens a SQLite database, creating its folder first. `:memory:` opens a throwaway one. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return db;
}

/** The app's database: Better Auth's tables and the `customer` table, in one SQLite file. */
export function getDatabase(): DatabaseSync {
  database ??= openDatabase(databasePath());
  return database;
}
