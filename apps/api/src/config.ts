import { sourceMigrationsDir } from '@pq/db';

export type AuthConfig =
  | { mode: 'dev'; email: string }
  | { mode: 'access'; teamDomain: string; audience: string };

export interface Config {
  production: boolean;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  mediaDir: string;
  migrationsDir: string;
  webDir: string | null;
  auth: AuthConfig;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`${key} is required`);
  return v;
}

/** Normalises "myteam", "myteam.cloudflareaccess.com" or "https://myteam.cloudflareaccess.com/" to the bare host. */
export function normaliseTeamDomain(raw: string): string {
  const host = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return host.includes('.') ? host : `${host}.cloudflareaccess.com`;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const production = env.NODE_ENV === 'production';
  if (env.DEV_AUTH === '1') {
    if (production) throw new ConfigError('DEV_AUTH=1 is refused when NODE_ENV=production');
    return { mode: 'dev', email: env.DEV_AUTH_EMAIL?.trim() || 'owner@example.test' };
  }
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !audience) {
    throw new ConfigError(
      'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required (the app never runs without the access gate; use DEV_AUTH=1 for local development)',
    );
  }
  return { mode: 'access', teamDomain: normaliseTeamDomain(teamDomain), audience };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError('PORT is invalid');
  return {
    production: env.NODE_ENV === 'production',
    host: env.HOST ?? '0.0.0.0',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: required(env, 'DATABASE_URL'),
    mediaDir: env.MEDIA_DIR ?? '/data/media',
    migrationsDir: env.MIGRATIONS_DIR ?? sourceMigrationsDir,
    webDir: env.WEB_DIR ?? null,
    auth: loadAuthConfig(env),
  };
}
