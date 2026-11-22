import { signal } from '@preact/signals';
import { render } from 'preact';
import { api, ApiError, type Me } from './api';
import './style.css';

const me = signal<Me | null>(null);
const error = signal<string | null>(null);

api<Me>('/api/v1/me').then(
  (m) => (me.value = m),
  (err) => (error.value = err instanceof ApiError && err.status === 403 ? 'You are signed in but not a member of this household.' : 'Could not reach the server.'),
);

function App() {
  return (
    <main>
      <header>
        <h1>Quartermaster</h1>
        {me.value && <p class="muted" data-testid="household">{me.value.household.name}</p>}
      </header>
      {error.value && <p role="alert">{error.value}</p>}
      {!me.value && !error.value && <p class="muted">Loading…</p>}
      {me.value && (
        <section class="card">
          <p>
            Signed in as <strong data-testid="member-name">{me.value.member.display_name}</strong> ({me.value.member.role})
          </p>
          <p class="muted">Inventory arrives in M1.</p>
        </section>
      )}
    </main>
  );
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
