import { Clock } from 'lucide-react';

/**
 * Shown to customers when a restaurant's subscription has lapsed.
 *
 * Deliberately brand-neutral and free of any billing language: the visitor is
 * not the party who owes anything, and "this restaurant hasn't paid" is a
 * reputational hit we have no right to inflict. It reads as a temporary
 * closure, which is what it is from the customer's side.
 *
 * No data is deleted on suspension — paying restores this page instantly.
 */
export function SuspendedStorefront({ brandName }: { brandName: string }) {
  return (
    <div className="container flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 py-16 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Clock className="h-8 w-8" />
      </span>
      <h1 className="mt-6 font-display text-2xl font-bold">
        {brandName} is not taking orders right now
      </h1>
      <p className="mt-3 text-muted-foreground">
        Online ordering for this location is temporarily unavailable. Please check back soon, or
        contact the restaurant directly to order.
      </p>
    </div>
  );
}
