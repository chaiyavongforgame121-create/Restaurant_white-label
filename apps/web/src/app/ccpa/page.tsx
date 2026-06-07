import { CcpaToggle } from './_components/ccpa-toggle';

export const metadata = { title: 'CCPA Notice · Favornoms' };

export default function CcpaPage() {
  return (
    <main className="container max-w-3xl py-12 text-sm leading-relaxed">
      <h1 className="font-display text-3xl font-bold">California Consumer Privacy Notice</h1>
      <p className="mt-1 text-muted-foreground">
        Last updated: {new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}
      </p>

      <Section title="Your CCPA / CPRA rights">
        <ul className="ml-6 list-disc space-y-1">
          <li><strong>Right to know:</strong> request a copy of the personal information we hold.</li>
          <li><strong>Right to delete:</strong> ask us to delete your account and personal information.</li>
          <li><strong>Right to correct:</strong> ask us to correct inaccurate personal information.</li>
          <li><strong>Right to opt-out:</strong> opt out of any sale or sharing of personal information for cross-context behavioral advertising.</li>
          <li><strong>Right to limit:</strong> limit our use of sensitive personal information.</li>
          <li><strong>Right to non-discrimination:</strong> we will not deny service or charge different prices because you exercise your rights.</li>
        </ul>
      </Section>

      <Section title="Do Not Sell or Share My Personal Information">
        <p>
          We do not sell personal information for money. To opt out of sharing for cross-context
          behavioral advertising, toggle the switch below. We will record your preference and
          forward Global Privacy Control (GPC) signals when detected.
        </p>
        <div className="mt-3">
          <CcpaToggle />
        </div>
      </Section>

      <Section title="Submit a request">
        <p>
          For copy / deletion / correction requests, sign in to your account and use the controls
          on <a className="text-primary underline" href="/account">/account</a>, or email{' '}
          <a className="text-primary underline" href="mailto:privacy@favornoms.com">privacy@favornoms.com</a>.
        </p>
        <p>
          We will verify your request by sending a one-time code to the phone number on file. We
          respond within 45 days as required by the CCPA.
        </p>
      </Section>

      <Section title="Authorized agents">
        <p>
          You may use an authorized agent to submit a request on your behalf. The agent must
          provide a signed authorization and we may contact you to verify.
        </p>
      </Section>
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
