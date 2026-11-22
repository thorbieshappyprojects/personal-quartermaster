import { useSignal } from '@preact/signals';
import { api } from '../api';
import { ErrorNote } from '../components/ui';
import { categories, categoryOptions, refreshCategories } from '../store';

export function CategoriesPage() {
  const error = useSignal<string | null>(null);
  const editing = useSignal<string | null>(null);
  const text = useSignal('');
  const parent = useSignal('');

  async function run(fn: () => Promise<unknown>) {
    error.value = null;
    try {
      await fn();
      await refreshCategories();
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  return (
    <main>
      <h1>Categories</h1>
      <ErrorNote error={error.value} />
      <form
        class="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.post('/api/v1/categories', { name: text.value.trim(), parent_id: parent.value || null });
            text.value = '';
          });
        }}
      >
        <input required maxLength={200} placeholder="New category" value={text.value} onInput={(e) => (text.value = (e.currentTarget as HTMLInputElement).value)} aria-label="New category" />
        <select value={parent.value} onChange={(e) => (parent.value = (e.currentTarget as HTMLSelectElement).value)} aria-label="Inside">
          <option value="">(top level)</option>
          {categoryOptions.value.filter((o) => o.path.length === 1).map((o) => (
            <option key={o.node.id} value={o.node.id}>in {o.node.name}</option>
          ))}
        </select>
        <button class="primary" type="submit">Add</button>
      </form>
      <ul class="cat-list">
        {categoryOptions.value.map((o) => {
          const c = o.node;
          const hasChildren = categories.value.some((x) => x.parent_id === c.id);
          return (
            <li key={c.id} style={{ paddingLeft: `${(o.path.length - 1) * 1.2}rem` }}>
              {editing.value === c.id ? (
                <form class="inline-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.patch(`/api/v1/categories/${c.id}`, { name: text.value.trim() }); editing.value = null; text.value = ''; }); }}>
                  <input required autoFocus maxLength={200} value={text.value} onInput={(e) => (text.value = (e.currentTarget as HTMLInputElement).value)} aria-label="Category name" />
                  <button class="primary" type="submit">Save</button>
                  <button class="link" type="button" onClick={() => { editing.value = null; text.value = ''; }}>Cancel</button>
                </form>
              ) : (
                <>
                  <span>{c.name}</span>
                  {c.item_count > 0 && <span class="muted small"> {c.item_count}</span>}
                  <span class="row-tools">
                    <button type="button" class="link" onClick={() => { editing.value = c.id; text.value = c.name; }}>Rename</button>
                    {!hasChildren && c.item_count === 0 && (
                      <button type="button" class="link danger-text" onClick={() => void run(() => api.del(`/api/v1/categories/${c.id}`))}>Delete</button>
                    )}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
