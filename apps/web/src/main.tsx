import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { CategoriesPage } from './pages/Categories';
import { CheckPage } from './pages/Check';
import { ImportPage } from './pages/Import';
import { SpendingPage } from './pages/Spending';
import { ItemDetailPage } from './pages/ItemDetail';
import { ItemFormPage } from './pages/ItemForm';
import { MorePage } from './pages/More';
import { PlacesPage } from './pages/Places';
import { SearchPage } from './pages/Search';
import { Link, match, pathname, route } from './router';
import { boot, bootError, me } from './store';
import './style.css';

function Page() {
  void route.value; // re-render on navigation
  let m: Record<string, string> | null;
  if (pathname() === '/') return <SearchPage key={route.value} />;
  if (pathname() === '/items/new') return <ItemFormPage key={route.value} />;
  if ((m = match('/items/:id/edit'))) return <ItemFormPage key={m.id} id={m.id} />;
  if ((m = match('/items/:id'))) return <ItemDetailPage key={m.id} id={m.id!} />;
  if (pathname() === '/places') return <PlacesPage key="root" />;
  if ((m = match('/places/:id'))) return <PlacesPage key={m.id} id={m.id} />;
  if (pathname() === '/categories') return <CategoriesPage />;
  if (pathname() === '/more') return <MorePage />;
  if (pathname() === '/history') return <CheckPage />;
  if (pathname() === '/history/import') return <ImportPage />;
  if (pathname() === '/history/spending') return <SpendingPage />;
  return (
    <main>
      <h1>Not found</h1>
      <Link href="/">Back to search</Link>
    </main>
  );
}

function Tab({ href, label, icon }: { href: string; label: string; icon: string }) {
  const p = pathname();
  const active = href === '/' ? p === '/' : p.startsWith(href);
  return (
    <Link href={href} class={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
      <span aria-hidden="true" class="icon">{icon}</span>
      <span>{label}</span>
    </Link>
  );
}

function App() {
  useEffect(() => void boot(), []);
  if (bootError.value) return <main><h1>Quartermaster</h1><p role="alert" class="error">{bootError.value}</p></main>;
  if (!me.value) return <main><p class="muted">Loading…</p></main>;
  return (
    <>
      <Page />
      <nav class="tabs" aria-label="Main">
        <Tab href="/" label="Search" icon="⌕" />
        <Tab href="/items/new" label="Add" icon="＋" />
        <Tab href="/places" label="Places" icon="⌂" />
        <Tab href="/history" label="History" icon="◷" />
        <Tab href="/more" label="More" icon="≡" />
      </nav>
    </>
  );
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
