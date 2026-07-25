import Link from 'next/link';
import {
  Bike, Check, ChefHat, ChevronRight, CreditCard, LineChart,
  Megaphone, MonitorPlay, ShoppingBag, Star, Store, Zap,
} from 'lucide-react';

export const metadata = {
  title: 'Favornoms — All-in-one ordering platform for restaurants',
  description:
    'Run delivery, pickup, dine-in, KDS, POS, and driver dispatch from one platform. $199/mo, 14-day free trial. Built for US restaurants.',
};

// The merchant back office is a separate deployment, so signup and onboarding
// live on another origin. Defaults to the local dev port so `pnpm dev` links
// work without any .env.local at all.
const MERCHANT_URL = (
  process.env.NEXT_PUBLIC_MERCHANT_URL ?? 'http://localhost:3004'
).replace(/\/$/, '');
const SIGNUP_URL = `${MERCHANT_URL}/signup`;

export default function RootPage() {
  return (
    <main className="overflow-hidden">
      {/* Hero */}
      <section className="relative bg-gradient-warm text-white">
        <div className="absolute inset-0 bg-noise opacity-30" aria-hidden />
        <div className="container relative max-w-6xl py-20 sm:py-28">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur">
                <Zap className="h-3.5 w-3.5" /> US-launch ready
              </span>
              <h1 className="mt-5 font-display text-4xl font-bold leading-tight sm:text-5xl lg:text-6xl">
                Your restaurant.
                <br />Online, in one place.
              </h1>
              <p className="mt-5 max-w-lg text-lg text-white/85">
                Take orders online, run your kitchen, dispatch drivers, take card payments, and grow
                your loyal customer base — without juggling five different tools.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <a
                  href={SIGNUP_URL}
                  className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-white px-6 text-base font-semibold text-primary shadow-warm hover:bg-white/95"
                >
                  Start 14 days free <ChevronRight className="h-4 w-4" />
                </a>
                <Link
                  href="/r/coastal-grill/brooklyn"
                  className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-2xl border border-white/40 px-6 text-base font-semibold text-white hover:bg-white/10"
                >
                  See a live menu
                </Link>
              </div>
              <p className="mt-4 text-xs text-white/70">
                No credit card required &middot; every feature unlocked during the trial
              </p>
            </div>

            {/* Stylized phone mock */}
            <div className="relative hidden lg:block">
              <div className="absolute inset-0 -m-8 rounded-[2.5rem] bg-white/5 blur-3xl" />
              <div className="relative mx-auto max-w-xs rounded-[2rem] bg-white/10 p-3 shadow-warm backdrop-blur">
                <div className="aspect-[9/19] overflow-hidden rounded-[1.5rem] bg-card text-card-foreground">
                  <div className="bg-gradient-warm p-6 text-white">
                    <p className="text-xs font-semibold uppercase tracking-wider">Brooklyn Flagship</p>
                    <h3 className="mt-1 font-display text-xl font-bold">Coastal Grill</h3>
                  </div>
                  <div className="space-y-3 p-4 text-foreground">
                    <MockItem name="Smash Burger" price="$14.95" />
                    <MockItem name="Buffalo Wings" price="$13.50" />
                    <MockItem name="Cobb Salad" price="$13.95" />
                    <MockItem name="Cheesecake" price="$6.95" />
                  </div>
                  <div className="border-t border-border/60 p-4">
                    <button className="w-full rounded-xl bg-gradient-warm py-2.5 text-sm font-bold text-white">
                      Checkout · $42.45
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trusted */}
      <section className="border-b border-border/40 bg-card py-6 text-center text-xs uppercase tracking-wider text-muted-foreground">
        Trusted by independent restaurants from Brooklyn to Brentwood
      </section>

      {/* Features */}
      <section className="container max-w-6xl py-20">
        <div className="text-center">
          <h2 className="font-display text-3xl font-bold sm:text-4xl">Everything you need to run service</h2>
          <p className="mt-3 text-muted-foreground">Five apps. One database. Zero hand-offs.</p>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Feature
            icon={<ShoppingBag className="h-5 w-5" />}
            title="Customer storefront"
            description="Branded menus on your custom domain. Cart, checkout, loyalty redemption."
          />
          <Feature
            icon={<ChefHat className="h-5 w-5" />}
            title="Kitchen Display"
            description="Realtime tickets, station routing, long-press to 86 an item — keep the line moving."
          />
          <Feature
            icon={<CreditCard className="h-5 w-5" />}
            title="Card payment"
            description="Take cards online and at the counter. Refunds and sales-tax compliant receipts from one dashboard."
          />
          <Feature
            icon={<Bike className="h-5 w-5" />}
            title="Driver dispatch"
            description="Auto-route to your nearest online driver. GPS tracking customers can watch live."
          />
          <Feature
            icon={<Megaphone className="h-5 w-5" />}
            title="Marketing tools"
            description="Push, SMS, email blasts. Loyalty points. Promo codes. Bring guests back."
          />
          <Feature
            icon={<LineChart className="h-5 w-5" />}
            title="Reports & insights"
            description="Revenue, peak hours, top items, customer LTV — without exporting to Excel."
          />
        </div>
      </section>

      {/* Pricing */}
      <section className="bg-muted/40 py-20">
        <div className="container max-w-5xl">
          <div className="text-center">
            <h2 className="font-display text-3xl font-bold sm:text-4xl">One base plan. Add what you need.</h2>
            <p className="mt-3 text-muted-foreground">
              No menu-item limits. No cap on orders. Cancel any time.
            </p>
          </div>

          <div className="mx-auto mt-10 max-w-md rounded-3xl border-2 border-primary bg-card p-7 shadow-warm">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Base</p>
            <p className="mt-2 font-display text-5xl font-bold">
              $199<span className="text-lg font-normal text-muted-foreground">/mo</span>
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Everything you need to run one location, including card payment.
            </p>
            <ul className="mt-5 space-y-2 text-left">
              {[
                'Branded storefront on your own domain',
                // Deliberately does NOT say "into your own Stripe account" yet:
                // stripe-create-payment-intent still charges through a single
                // platform key with no Connect account, so order money would not
                // land in the restaurant's Stripe. Restore that wording the day
                // Connect onboarding ships.
                'Card and cash payments at checkout',
                'Kitchen Display, POS and counter ordering',
                'Loyalty, promos, gift cards and reports',
                'AI menu import — photograph a menu, get a menu',
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  {f}
                </li>
              ))}
            </ul>
            <a
              href={SIGNUP_URL}
              className="focus-ring mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-base font-semibold text-primary-foreground shadow-warm hover:bg-primary/90"
            >
              Start 14 days free
            </a>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Free for 14 days with every add-on included. No card until you decide.
            </p>
          </div>

          <p className="mt-12 text-center text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Add on when you need it
          </p>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <AddonTile
              icon={<Bike className="h-5 w-5" />}
              name="Delivery"
              price="+$49"
              tag="Your own riders, automatic dispatch and live tracking."
            />
            <AddonTile
              icon={<MonitorPlay className="h-5 w-5" />}
              name="AI Suite"
              price="+$59"
              tag="Digital Signage and the AI Voice Assistant."
            />
            <AddonTile
              icon={<Store className="h-5 w-5" />}
              name="Extra branch"
              price="+$99"
              tag="Each additional location, with the full feature set of your main branch."
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/40 bg-card py-8">
        <div className="container max-w-6xl flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-warm text-white">
              <ChefHat className="h-4 w-4" />
            </span>
            <span className="font-display font-semibold text-foreground">Favornoms</span>
          </div>
          <nav className="flex flex-wrap gap-4">
            <Link href="/help" className="hover:text-foreground">Help</Link>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
            <Link href="/ccpa" className="hover:text-foreground">CCPA</Link>
            <Link href="/account" className="hover:text-foreground">Account</Link>
            <a href="mailto:hello@favornoms.com" className="hover:text-foreground">Contact</a>
          </nav>
          <p className="text-xs">&copy; {new Date().getFullYear()} Favornoms</p>
        </div>
      </footer>
    </main>
  );
}

function MockItem({ name, price }: { name: string; price: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Star className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium">{name}</span>
      </div>
      <span className="font-display text-sm font-bold text-primary tabular-nums">{price}</span>
    </div>
  );
}

function Feature({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 transition-shadow hover:shadow-warm">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">{icon}</span>
      <h3 className="mt-4 font-display text-lg font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function AddonTile({ icon, name, price, tag }: { icon: React.ReactNode; name: string; price: string; tag: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/20 text-accent-foreground">
        {icon}
      </span>
      <p className="mt-4 font-display text-lg font-semibold">{name}</p>
      <p className="mt-1 font-display text-2xl font-bold">
        {price}<span className="text-sm font-normal text-muted-foreground">/mo</span>
      </p>
      <p className="mt-2 text-sm text-muted-foreground">{tag}</p>
    </div>
  );
}
