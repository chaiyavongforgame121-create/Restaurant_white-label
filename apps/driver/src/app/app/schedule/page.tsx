'use client';

import { ScheduleEditor } from '@/components/schedule-editor';

export default function SchedulePage() {
  return (
    <div className="container max-w-xl py-6">
      <header className="mb-5 px-1">
        <h1 className="font-display text-2xl font-bold">My schedule</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the hours you want to work at each restaurant. You go online automatically when a
          window starts and offline when it ends — toggle a restaurant off anytime to override.
        </p>
      </header>
      <ScheduleEditor />
    </div>
  );
}
