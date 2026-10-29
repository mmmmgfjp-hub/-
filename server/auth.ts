import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { DB } from './db';
import { getSetting, setSetting } from './db';
import type { AppConfig } from './config';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
export const SESSION_COOKIE = 'iay_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type Role = 'customer' | 'admin' | 'owner';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  country_code: string | null;
  country_updated_at: string | null;
  country_change_count: number;
  email_verified: number;
  role: Role;
  status: 'active' | 'suspended';
  free_access: 'none' | 'lifetime';
  free_access_granted_at: string | null;
  free_access_granted_by: string | null;
  token_version: number;
  created_at: string;
  last_login_at: string | null;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = await scrypt(password, salt, expected.length || SCRYPT_KEYLEN);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Session secret resolution order: env SESSION_SECRET, else a secret generated
 * once and persisted in the database (never in the client, never hardcoded).
 */
export function resolveSessionSecret(db: DB, cfg: AppConfig): string {
  if (cfg.sessionSecret && cfg.sessionSecret.length >= 32) return cfg.sessionSecret;
  const existing = getSetting(db, 'session_secret');
  if (existing && existing.length >= 32) return existing;
  const secret = crypto.randomBytes(48).toString('hex');
  setSetting(db, 'session_secret', secret, null);
  return secret;
}

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  status: 'active' | 'suspended';
  emailVerified: boolean;
  displayName: string | null;
  countryCode: string | null;
  freeAccess: 'none' | 'lifetime';
  createdAt: string;
  countryUpdatedAt: string | null;
  countryChangeCount: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      clientIp?: string;
    }
  }
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    emailVerified: row.email_verified === 1,
    displayName: row.display_name,
    countryCode: row.country_code,
    freeAccess: row.free_access,
    createdAt: row.created_at,
    countryUpdatedAt: row.country_updated_at,
    countryChangeCount: row.country_change_count,
  };
}

export function findUserById(db: DB, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function findUserByEmail(db: DB, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as
    | UserRow
    | undefined;
}

export function signSession(secret: string, user: UserRow): string {
  return jwt.sign({ sub: user.id, tv: user.token_version }, secret, {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}

export interface AuthDeps {
  db: DB;
  secret: string;
}

export function attachUser({ db, secret }: AuthDeps) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
    req.clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
    if (!token) return next();
    try {
      const payload = jwt.verify(token, secret) as { sub: string; tv?: number };
      const row = findUserById(db, payload.sub);
      if (!row) return next();
      if (typeof payload.tv === 'number' && payload.tv !== row.token_version) return next();
      req.user = toAuthUser(row);
    } catch {
      /* invalid or expired token: continue as anonymous */
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Authentication required.' });
    return;
  }
  if (req.user.status === 'suspended') {
    res.status(403).json({
      error: 'ACCOUNT_SUSPENDED',
      message: 'This account is suspended. Contact the administrator.',
    });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Authentication required.' });
    return;
  }
  if (req.user.role !== 'owner' && req.user.role !== 'admin') {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Administrator access only.' });
    return;
  }
  if (req.user.status === 'suspended') {
    res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'Account suspended.' });
    return;
  }
  next();
}
