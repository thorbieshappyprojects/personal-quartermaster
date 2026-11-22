import { fileURLToPath } from 'node:url';

/** Location of the SQL migrations when running from the source tree. Bundled builds pass their own path. */
export const sourceMigrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
