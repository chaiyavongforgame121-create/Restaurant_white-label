'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, GraduationCap } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, useUiLocale } from '@favornoms/ui';
import { intlLocaleFor } from '@favornoms/shared';
import { useDriverSession } from '@/components/driver-session';

/** The answer keys under `onboarding.training.modules.{id}.choices`, in display order. */
type ChoiceKey = 'a' | 'b' | 'c';

interface Module {
  /** Written to driver_training.completed_modules — a code, never a label. */
  id: 'safety' | 'pickup' | 'delivery' | 'issues';
  quiz: Array<{ choices: readonly ChoiceKey[]; correctIndex: number }>;
}

// The reading, question and answers for each module are in the `onboarding` catalogue under
// `training.modules.{id}`. Only what is scored lives here: which answer is right.
const MODULES: Module[] = [
  { id: 'safety', quiz: [{ choices: ['a', 'b', 'c'], correctIndex: 1 }] },
  { id: 'pickup', quiz: [{ choices: ['a', 'b', 'c'], correctIndex: 1 }] },
  { id: 'delivery', quiz: [{ choices: ['a', 'b', 'c'], correctIndex: 1 }] },
  { id: 'issues', quiz: [{ choices: ['a', 'b', 'c'], correctIndex: 1 }] },
];

export function TrainingView() {
  const t = useTranslations('onboarding');
  const locale = useUiLocale();
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
          <h1 className="font-display text-2xl font-bold">{t('training.title')}</h1>
          <p className="text-xs text-muted-foreground">
            {savedAt
              ? t('training.completedOn', {
                  date: new Date(savedAt).toLocaleDateString(intlLocaleFor(locale)),
                })
              : t('training.required')}
          </p>
        </div>
      </header>

      <ul className="space-y-3">
        {MODULES.map((m) => (
          <li key={m.id}>
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-semibold">
                  {t(`training.modules.${m.id}.title`)}
                </h2>
                {completed.includes(m.id) && (
                  <Badge variant="success" className="flex items-center gap-1">
                    <Check className="h-3 w-3" /> {t('training.done')}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(`training.modules.${m.id}.description`)}
              </p>
              <p className="mt-2 text-sm">{t(`training.modules.${m.id}.reading`)}</p>
              <div className="mt-3 rounded-xl bg-muted/40 p-3">
                <p className="text-sm font-semibold">{t(`training.modules.${m.id}.question`)}</p>
                <div className="mt-2 space-y-1">
                  {m.quiz[0]!.choices.map((c, i) => (
                    <label key={i} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`q-${m.id}`}
                        checked={answers[m.id] === i}
                        onChange={() => setAnswers((curr) => ({ ...curr, [m.id]: i }))}
                      />
                      {t(`training.modules.${m.id}.choices.${c}`)}
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
        {allModulesPassed ? t('training.submit') : t('training.answerAll')}
      </Button>
    </div>
  );
}
