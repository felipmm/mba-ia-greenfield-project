import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

export function createTestDataSource(
  entities: (Function | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  // DELETE with TRUNCATE-like semantics, tolerant of missing tables.
  // Deletion order respects FK dependencies.
  await dataSource.query('DELETE FROM "videos" WHERE 1=1');
  await dataSource.query('DELETE FROM "refresh_tokens" WHERE 1=1');
  await dataSource.query('DELETE FROM "verification_tokens" WHERE 1=1');
  await dataSource.query('DELETE FROM "channels" WHERE 1=1');
  await dataSource.query('DELETE FROM "users" WHERE 1=1');
}
