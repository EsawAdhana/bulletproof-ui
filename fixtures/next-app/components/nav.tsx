import Link from 'next/link';

export function Nav() {
  return (
    <nav className="border-b border-muted/20">
      <div className="mx-auto flex max-w-3xl items-center gap-6 px-4 py-3 text-sm">
        <Link href="/" className="font-semibold text-brand">Fixture</Link>
        <Link href="/about" className="text-muted hover:text-ink">About</Link>
      </div>
    </nav>
  );
}
