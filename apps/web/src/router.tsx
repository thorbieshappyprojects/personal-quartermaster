import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';

const current = () => location.pathname + location.search;
export const route = signal(current());

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === current()) return;
  history[opts.replace ? 'replaceState' : 'pushState'](null, '', to);
  route.value = to;
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => {
  route.value = current();
});

export function pathname(): string {
  return route.value.split('?')[0] ?? '/';
}

export function query(name: string): string | null {
  return new URLSearchParams(route.value.split('?')[1] ?? '').get(name);
}

/** "/items/:id" against "/items/123" → { id: "123" }, or null. */
export function match(pattern: string, path = pathname()): Record<string, string> | null {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith(':')) out[seg.slice(1)] = decodeURIComponent(a[i]!);
    else if (seg !== a[i]) return null;
  }
  return out;
}

interface LinkProps {
  href: string;
  children: ComponentChildren;
  class?: string;
  'aria-current'?: 'page';
  'data-testid'?: string;
}

export function Link(props: LinkProps) {
  const { href, children, ...rest } = props;
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
