import type { ItemKind, ItemState, LocationKind } from '@pq/core/browser';

export interface Me {
  member: { id: string; display_name: string; role: 'owner' | 'member'; email: string };
  household: { id: string; name: string; base_currency: string };
  via: string;
}
export interface Location {
  id: string;
  parent_id: string | null;
  kind: LocationKind;
  name: string;
  notes: string | null;
  item_count: number;
}
export interface Category {
  id: string;
  parent_id: string | null;
  name: string;
  default_kind: ItemKind | null;
  item_count: number;
}
export interface Person {
  id: string;
  display_name: string;
  kind: 'member' | 'dependant';
  member_id: string | null;
}
export interface Photo {
  document_id: string;
  url: string;
  thumb_url: string;
  width: number | null;
  height: number | null;
}
export interface Item {
  id: string;
  kind: ItemKind;
  name: string;
  aliases: string[];
  category_id: string | null;
  category_path: string[];
  location_id: string | null;
  location_path: string[];
  belongs_to_person_id: string | null;
  state: ItemState;
  quantity: number;
  unit: string | null;
  price_amount_minor: number | null;
  price_currency: string | null;
  purchase_url: string | null;
  notes: string | null;
  tags: string[];
  attributes: Record<string, string | number | boolean | null>;
  acquired_at: string | null;
  photos: Photo[];
  created_at: string;
  updated_at: string;
}
export interface ItemPage {
  total: number;
  items: Item[];
}
export interface FindResult {
  terms: string;
  answer: string;
  items: Item[];
}
export interface EventRow {
  id: string;
  actor_name: string | null;
  type: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'offline', 'Could not reach the server. Check the connection.');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    const fallback = res.status === 403 ? 'Not allowed.' : res.status === 401 ? 'Please sign in again.' : `Request failed (${res.status}).`;
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? fallback);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: (path: string) => request<void>('DELETE', path),
  upload: <T>(path: string, file: Blob, filename: string) => {
    const fd = new FormData();
    fd.append('file', file, filename);
    return request<T>('POST', path, fd);
  },
};

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};
