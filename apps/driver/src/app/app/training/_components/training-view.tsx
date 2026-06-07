'use client';

import * as React from 'react';
import { Check, GraduationCap } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

interface Module {
  id: string;
  title: string;
  description: string;
  reading: string;
  quiz: Array<{ q: string; choices: string[]; correctIndex: number }>;
}

const MODULES: Module[] = [
  {
    id: 'safety',
    title: '1 · Driver safety',
    description: 'Bike & car safety basics',
    reading:
      'Always wear a helmet. Never check your phone while driving. Pull over before opening the app. Always confirm the address before leaving the restaurant.',
    quiz: [
      {
        q: 'When should you check the app?',
        choices: ['While riding', 'After pulling over', 'At red lights'],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 'pickup',
    title: '2 · At the restaurant',
    description: 'Pickup checklist',
    reading:
      'Show your driver ID. Confirm the order number with the host. Check that the bag contains all items and is sealed. Tap "Picked up" only after confirming.',
    quiz: [
      {
        q: 'What should you verify at pickup?',
        choices: ['Just the order number', 'Order number + items + seal', 'Nothing — just grab the bag'],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 'delivery',
    title: '3 · Delivery etiquette',
    description: 'Customer interaction',
    reading:
      'Greet the customer by name. Confirm the order. Hand over the bag with two hands. If contactless, take a photo to prove delivery. Never demand a tip.',
    quiz: [
      {
        q: 'What proves a contactless delivery?',
        choices: ['Knocking', 'A photo at the door', 'Texting the customer'],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 'issues',
    title: '4 · Handling issues',
    description: 'What to do when things go wrong',
    reading:
      'If the customer is missing or unreachable: try calling twice, then text. Wait 5 minutes. Then mark "no answer" in the app. Never leave food unattended in a public area.',
    quiz: [
      {
        q: 'How long should you wait if the customer doesn\'t answer?',
        choices: ['1 minute', '5 minutes', '20 minutes'],
        correctIndex: 1,
      },
    ],
  },
];

export function TrainingView() {
  const { driver } = useDriverSession();
  const [completed, setCompleted] = React.useState<string[]>([]);
  const [answers, setAnswers] = React.useState<Record<string, number>>({});
  const [savedAt, setSavedAt] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      if (!driver?.id) return;
      const supabase = getBrowserClient();
      const { data } = await supabase
        .from('driver_training')
        .select('completed_modules, quiz_score, quiz_passed, completed_at')
        .eq('driver_id', driver.id)
        .maybeSingle();
      if (data) {
        setCompleted((data.completed_modules as string[]) ?? []);
        if (data.completed_at) setSavedAt(data.completed_at);
      }
    })();
  }, [driver?.id]);

  const allModulesPassed = MODULES.every((m) =>
    answers[m.id] !== undefined && m.quiz[0]?.correctIndex === answers[m.id],
  );

  const submit = async () => {
    if (!driver?.id) return;
    setBusy(true);
    const supabase = getBrowserClient();
    const score = MODULES.filter(
      (m) => answers[m.id] === m.quiz[0]?.correctIndex,
    ).length;
    const moduleIds = MODULES.map((m) => m.id);
    const passed = score === MODULES.length;
    const { error: upErr } = await supabase
      .from('driver_training')
      .upsert({
        driver_id: driver.id,
        completed_modules: moduleIds,
        quiz_score: score,
        quiz_passed: passed,
        completed_at: passed ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      });
    setBusy(false);
    if (!upErr && passed) setSavedAt(new Date().toISOString());
  };

  return (
    <div className="px-4 pt-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-2xl bg-primary/10 text-primary">
          <GraduationCap className="h-5 w-5" />
        </span>
        <div>
          <h1 className="font-display text-2xl font-bold">Driver training</h1>
          <p className="text-xs text-muted-foreground">
            {savedAt ? `Completed ${new Date(savedAt).toLocaleDateString()}` : 'Required for first dispatch.'}
          </p>
        </div>
      </header>

      <ul className="space-y-3">
        {MODULES.map((m) => (
          <li key={m.id}>
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-semibold">{m.title}</h2>
                {completed.includes(m.id) && (
                  <Badge variant="success" className="flex items-center gap-1">
                    <Check className="h-3 w-3" /> Done
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>
              <p className="mt-2 text-sm">{m.reading}</p>
              <div className="mt-3 rounded-xl bg-muted/40 p-3">
                <p className="text-sm font-semibold">{m.quiz[0]!.q}</p>
                <div className="mt-2 space-y-1">
                  {m.quiz[0]!.choices.map((c, i) => (
                    <label key={i} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`q-${m.id}`}
                        checked={answers[m.id] === i}
                        onChange={() => setAnswers((curr) => ({ ...curr, [m.id]: i }))}
                      />
                      {c}
                    </label>
                  ))}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>

      <Button
        variant="gradient"
        size="xl"
        fullWidth
        className="mt-6"
        loading={busy}
        disabled={!allModulesPassed}
        onClick={submit}
      >
        {allModulesPassed ? 'Submit & complete training' : 'Answer all questions correctly to continue'}
      </Button>
    </div>
  );
}
