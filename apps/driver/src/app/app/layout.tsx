import { AppErrorBoundary } from '@/components/app-error-boundary';
import { DeliveryProvider } from '@/components/delivery-provider';
import { DriverSessionProvider } from '@/components/driver-session';
import { DriverShell } from '@/components/driver-shell';
import { DriverLocationPing } from '@/components/driver-location-ping';
import { DispatchOfferOverlay } from '@/components/dispatch-sheet';
import { PushSubscriber } from '@/components/push-subscriber';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    // Outermost, so a crash in the session provider itself still lands somewhere with a way
    // out rather than on a blank standalone window.
    <AppErrorBoundary>
      <DriverSessionProvider>
        <DeliveryProvider>
          <DriverLocationPing />
          <PushSubscriber />
          {/* Above the shell, so an offer can be accepted from whichever tab the rider is
              on. A dispatch offer expires on a server clock and costs them a penalty when
              it lapses — it cannot be reachable from one screen only. */}
          <DispatchOfferOverlay />
          <DriverShell>{children}</DriverShell>
        </DeliveryProvider>
      </DriverSessionProvider>
    </AppErrorBoundary>
  );
}
