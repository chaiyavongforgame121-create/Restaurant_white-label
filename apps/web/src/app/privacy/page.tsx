export const metadata = { title: 'Privacy Policy · Favornoms' };

export default function PrivacyPage() {
  return (
    <main className="container max-w-3xl py-12 text-sm leading-relaxed">
      <h1 className="font-display text-3xl font-bold">Privacy Policy</h1>
      <p className="mt-1 text-muted-foreground">
        Last updated: {new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}
      </p>

      <Section title="1. Information we collect">
        <p>
          When you sign in we collect your phone number (used for one-time codes) and the name you
          choose to display. When you place an order we store the items, delivery address, and any
          notes you add. We do not collect payment-card data directly — that is handled by Stripe.
        </p>
      </Section>

      <Section title="2. How we use information">
        <p>
          We use your information to operate the service: route orders to the kitchen, dispatch
          drivers, send order-status notifications, and provide customer support. We may use
          aggregated, de-identified analytics to improve the product.
        </p>
      </Section>

      <Section title="3. Sharing">
        <p>
          We share order details with the restaurant you ordered from and the driver assigned to
          your delivery. We use service providers (Supabase for hosting, Stripe for payments,
          Resend for email, web-push providers for notifications) under data-processing agreements.
          We do not sell your personal information.
        </p>
      </Section>

      <Section title="4. Your rights (California residents)">
        <p>
          California residents have rights under the CCPA/CPRA to access, delete, and correct
          personal information, and to opt out of sale or sharing. See our{' '}
          <a className="text-primary underline" href="/ccpa">CCPA notice</a> for details and the
          &quot;Do Not Sell or Share My Personal Information&quot; toggle.
        </p>
      </Section>

      <Section title="5. Retention">
        <p>
          We retain order data for as long as it is needed to operate our service and to comply
          with tax and accounting obligations (typically 7 years for receipts). You may request
          deletion of your account at any time from <a className="text-primary underline" href="/account">your account page</a>.
        </p>
      </Section>

      <Section title="6. Security">
        <p>
          We use industry-standard safeguards: HTTPS for all traffic, row-level security in our
          database, and least-privilege access for our staff. No system is 100% secure, but we
          treat your data as if it were our own.
        </p>
      </Section>

      <Section title="7. Children">
        <p>The service is intended for users 13 and older.</p>
      </Section>

      <Section title="8. Changes">
        <p>
          We will post changes here and update the &quot;Last updated&quot; date above. Material
          changes will be communicated by email or in-app notification.
        </p>
      </Section>

      <Section title="9. Contact">
        <p>
          Privacy questions: <a className="text-primary underline" href="mailto:privacy@favornoms.com">privacy@favornoms.com</a>
        </p>
      </Section>

      <p className="mt-12 text-xs text-muted-foreground">
        This page is provided as a starting template. Have a lawyer review before launch.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      <div className="mt-2 space-y-2 text-foreground/85">{children}</div>
    </section>
  );
}
