export interface Me {
  member: { id: string; display_name: string; role: 'owner' | 'member' };
  household: { name: string; base_currency: string };
  via: string;
}

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...init?.headers } });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}
