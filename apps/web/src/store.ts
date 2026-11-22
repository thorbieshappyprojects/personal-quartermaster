import { computed, signal } from '@preact/signals';
import { indexById, pathNames } from '@pq/core/browser';
import { api, type Category, type Location, type Me, type Person } from './api';

export const me = signal<Me | null>(null);
export const locations = signal<Location[]>([]);
export const categories = signal<Category[]>([]);
export const persons = signal<Person[]>([]);
export const bootError = signal<string | null>(null);

const locIndex = computed(() => indexById(locations.value));
const catIndex = computed(() => indexById(categories.value));

export const locationPath = (id: string | null) => (id ? pathNames(locIndex.value, id) : []);
export const categoryPath = (id: string | null) => (id ? pathNames(catIndex.value, id) : []);

/** All nodes with their full path, sorted by path, for pickers. */
function withPaths<T extends { id: string; parent_id: string | null; name: string }>(nodes: T[], index: Map<string, T>) {
  return nodes
    .map((n) => ({ node: n, path: pathNames(index, n.id) }))
    .sort((a, b) => a.path.join('\u0000').localeCompare(b.path.join('\u0000'), undefined, { sensitivity: 'base' }));
}
export const locationOptions = computed(() => withPaths(locations.value, locIndex.value));
export const categoryOptions = computed(() => withPaths(categories.value, catIndex.value));

export async function refreshLocations() {
  locations.value = await api.get<Location[]>('/api/v1/locations');
}
export async function refreshCategories() {
  categories.value = await api.get<Category[]>('/api/v1/categories');
}

export async function boot() {
  try {
    const [m, l, c, p] = await Promise.all([
      api.get<Me>('/api/v1/me'),
      api.get<Location[]>('/api/v1/locations'),
      api.get<Category[]>('/api/v1/categories'),
      api.get<Person[]>('/api/v1/persons'),
    ]);
    me.value = m;
    locations.value = l;
    categories.value = c;
    persons.value = p;
  } catch (err) {
    const status = (err as { status?: number }).status;
    bootError.value = status === 403 ? 'You are signed in, but not a member of this household.' : (err as Error).message;
  }
}
