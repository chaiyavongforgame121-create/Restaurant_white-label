import { DeliveryProvider } from '@/components/delivery-provider';
import { DriverSessionProvider } from '@/components/driver-session';
import { DriverShell } from '@/components/driver-shell';
import { DriverLocationPing } from '@/components/driver-location-ping';
import { PushSubscriber } from '@/components/push-subscriber';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <DriverSessionProvider>
      <DeliveryProvider>
        <DriverLocationPing />
        <PushSubscriber />
        <DriverShell>{children}</DriverShell>
      </DeliveryProvider>
    </DriverSessionProvider>
  );
}
