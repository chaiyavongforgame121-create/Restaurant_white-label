import Link from 'next/link';
import { ChefHat, Home, Search } from 'lucide-react';
import { Button } from '@favornoms/ui';

export const metadata = { title: 'Not found · Favornoms' };

export default function NotFound() {
  return (
    <main className="grid min-h-dynamic-screen place-items-center bg-gradient-sunset px-6">
      <div className="text-center">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-white/15 text-white backdrop-blur">
          <ChefHat className="h-10 w-10" />
        </div>
        <p className="mt-6 font-display text-7xl font-bold text-gradient">404</p>
        <h1 className="mt-2 font-display text-2xl font-semibold">We couldn&apos;t find that page</h1>
        <p className="mt-2 max-w-sm text-muted-foreground">
          The restaurant or page you&apos;re looking for moved or never existed. Head home or try the demo.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/">
            <Button variant="gradient" size="lg" leftIcon={<Home className="h-4 w-4" />}>
              Back home
            </Button>
          </Link>
          <Link href="/r/coastal-grill/brooklyn">
            <Button variant="outline" size="lg" leftIcon={<Search className="h-4 w-4" />}>
              See the demo
            </Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
