export const metadata = { title: 'Terms of Service · Favornoms' };

export default function TermsPage() {
  return (
    <main className="container max-w-3xl py-12 text-sm leading-relaxed">
      <h1 className="font-display text-3xl font-bold">Terms of Service</h1>
      <p className="mt-1 text-muted-foreground">
        Last updated: {new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}
      </p>

      <Section title="1. Agreement">
        <p>
          By using Favornoms (the &quot;Service&quot;), you agree to these Terms. If you do not
          agree, do not use the Service.
        </p>
      </Section>

      <Section title="2. Eligibility">
        <p>You must be at least 13 years old to use the Service.</p>
      </Section>

      <Section title="3. Orders & payment">
        <p>
          Orders are an offer to purchase that the restaurant may accept or decline. Prices, item
          availability, and delivery zones are set by each restaurant. Payment is processed by
          Stripe. Cash payments are settled directly with the driver or restaurant.
        </p>
      </Section>

      <Section title="4. Refunds">
        <p>
          Refund policy is set by each restaurant. We facilitate refund requests but the
          restaurant has final authority. Stripe refunds typically appear within 5–10 business days.
        </p>
      </Section>

      <Section title="5. Acceptable use">
        <p>You agree not to:</p>
        <ul className="ml-6 list-disc space-y-1">
          <li>Use the Service for any unlawful purpose.</li>
          <li>Submit fraudulent orders or chargebacks.</li>
          <li>Interfere with or attempt to gain unauthorized access to the Service.</li>
          <li>Reverse-engineer or scrape the Service at scale without permission.</li>
        </ul>
      </Section>

      <Section title="6. Intellectual property">
        <p>
          The Service, its design, and content (other than user submissions and restaurant menus)
          are owned by Favornoms. You may not reproduce or redistribute without our written consent.
        </p>
      </Section>

      <Section title="7. Disclaimers">
        <p>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
          IMPLIED. We are not liable for restaurant food quality, delivery times, or any
          consequential damages, to the maximum extent permitted by law.
        </p>
      </Section>

      <Section title="8. Termination">
        <p>
          We may suspend or terminate your access for violation of these Terms. You may close your
          account at any time from <a className="text-primary underline" href="/account">your account page</a>.
        </p>
      </Section>

      <Section title="9. Governing law">
        <p>These Terms are governed by the laws of the State of Delaware, without regard to its
        conflicts-of-law principles. Any disputes will be resolved in the state or federal courts
        located in Delaware.</p>
      </Section>

      <Section title="10. Contact">
        <p>
          <a className="text-primary underline" href="mailto:legal@favornoms.com">legal@favornoms.com</a>
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
