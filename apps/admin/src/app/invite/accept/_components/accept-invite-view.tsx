'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { CheckCircle2, ChefHat, ShieldAlert } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { acceptStaffInvite } from '@favornoms/database/queries';

type State =
  | { kind: 'loading' }
  | { kind: 'not_signed_in' }
  | { kind: 'success'; restaurantId: string; branchId: string | null }
  | { kind: 'error'; message: string };

export function AcceptInviteView({ staffId }: { staffId?: string }) {
  const router = useRouter();
  const [state, setState] = React.useState<State>({ kind: 'loading' });

  React.useEffect(() => {
    if (!staffId) {
      setState({ kind: 'error', message: 'Missing staff_id in the invitation link.' });
      return;
    }
    void (async () => {
      const supabase = getBrowserClient();
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        setState({ kind: 'not_signed_in' });
        return;
      }
      try {
        const row = await acceptStaffInvite(supabase, staffId);
        setState({
          kind: 'success',
          restaurantId: row.restaurant_id,
          branchId: row.branch_id ?? null,
        });
      } catch (err) {
        setState({ kind: 'error', message: (err as Error).message });
      }
    })();
  }, [staffId]);

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <ChefHat className="h-8 w-8" />
        </div>

        {state.kind === 'loading' && (
          <Card className="p-6 text-center">
            <p className="font-display text-xl font-semibold">Linking your account…</p>
            <p className="mt-1 text-sm text-muted-foreground">One moment.</p>
          </Card>
        )}

        {state.kind === 'not_signed_in' && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
            <p className="mt-3 font-display text-xl font-semibold">Sign in required</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Open the invitation link from your email so you&apos;re signed in automatically.
            </p>
          </Card>
        )}

        {state.kind === 'error' && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-danger" />
            <p className="mt-3 font-display text-xl font-semibold">Couldn&apos;t accept invite</p>
            <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          </Card>
        )}

        {state.kind === 'success' && (
          <Card className="p-6 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            <p className="mt-3 font-display text-xl font-semibold">You&apos;re in!</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Welcome aboard. Head to your dashboard to get started.
            </p>
            <Button
              variant="gradient"
              size="lg"
              className="mt-5"
              fullWidth
              onClick={() => {
                if (state.branchId) router.push(`/b/${state.branchId}/dashboard`);
                else router.push('/');
              }}
            >
              Go to dashboard
            </Button>
          </Card>
        )}
      </motion.div>
    </div>
  );
}
