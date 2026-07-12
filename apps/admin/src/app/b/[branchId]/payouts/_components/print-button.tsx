'use client';

import { Button } from '@favornoms/ui';

export function PrintButton() {
  return (
    <Button size="sm" variant="outline" onClick={() => window.print()}>
      Print
    </Button>
  );
}
