export const settlingMigration: string;
export const boundedSettlingMigration: string;

export function createPreBoundedDiscSettlingProductionFixture(options: {
  databasePath: string;
  migrationsRoot?: URL;
}): void;
