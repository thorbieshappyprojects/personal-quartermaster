import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api } from '../api';
import { Link } from '../router';
import { me } from '../store';

interface Member { id: string; display_name: string; role: string }

export function MorePage() {
  const members = useSignal<Member[]>([]);
  useEffect(() => {
    api.get<Member[]>('/api/v1/members').then((m) => (members.value = m), () => undefined);
  }, []);
  const m = me.value;
  return (
    <main>
      <h1>More</h1>
      {m && (
        <p>
          Signed in as <strong data-testid="member-name">{m.member.display_name}</strong> ({m.member.role}) ·{' '}
          <span data-testid="household">{m.household.name}</span>
        </p>
      )}
      <ul class="menu">
        <li><Link href="/categories">Categories</Link></li>
        <li><a href="/api/v1/export" download>Export everything (zip)</a></li>
      </ul>
      <h2 class="section">Household</h2>
      <ul class="plain">
        {members.value.map((x) => (
          <li key={x.id}>{x.display_name} <span class="muted small">{x.role}</span></li>
        ))}
      </ul>
    </main>
  );
}
