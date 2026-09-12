'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2, ChevronRight, FileCheck2,
  HeartHandshake, LogOut, Star,
} from 'lucide-react';
import { Badge, Button, Card, vehicleTypeIcon } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useDriverSession } from '@/components/driver-session';
import { DriverInstallRow } from '@/components/install-app-button';
import { listDriverDocuments } from './document-storage';
import { documentsStage, documentsSummary, type DocFile, type DocsStage } from './documents';
import { formatPhone } from '@favornoms/shared';

/** The hero pill used to print the raw enum ("0.0 · pending"), which is a column name,
 *  not a status a rider can act on. */
const KYC_PILL: Record<string, string> = {
  verified: 'Verified',
  pending: 'In review',
  rejected: 'Action needed',
  suspended: 'Suspended',
};

const SUMMARY_CLASS: Record<DocsStage, string> = {
  unreadable: 'text-danger',
  incomplete: 'text-warning',
  awaiting: 'text-info',
  rechecking: 'text-warning',
  verified: 'text-success',
  changes_needed: 'text-danger',
};

export function ProfileView() {
  const { driver } = useDriverSession();
  const router = useRouter();

  // Uploading and reviewing now live on their own screen; this page keeps only the
  // one-line state, so the folder is listed without asking for signed previews.
  const [docs, setDocs] = React.useState<DocFile[]>([]);
  const [listError, setListError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void listDriverDocuments(driver.id, false).then((result) => {
      if (cancelled) return;
      setDocs(result.docs);
      setListError(result.error);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [driver.id]);

  const kycStatus = driver.kyc_status ?? 'pending';
  const stage = documentsStage({
    listFailed: listError !== null,
    docs,
    kycStatus,
    kycVerifiedAt: driver.kyc_verified_at,
  });
  const summary = loaded
    ? documentsSummary(stage, docs, driver.approvals ?? [])
    : 'Checking your documents…';

  const handleSignOut = async () => {
    const supabase = getBrowserClient();
    await supabase.auth.signOut();
    router.replace('/login');
  };

  // The rest of the product draws a car for "a delivery". This card is the exception: it
  // sits directly on top of the rider's own vehicle_type, which they entered themselves
  // and which is still 'motorcycle' for most riders, so it follows the row rather than
  // the brand. A car above the word "motorcycle" is the app arguing with its own data.
  const VehicleIcon = vehicleTypeIcon(driver.vehicle_type);

  return (
    <div className="px-4 pt-6 pb-6">
      <Card className="overflow-hidden p-0">
        <div className="bg-gradient-warm p-6 text-white">
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 place-items-center rounded-full bg-white/25 font-display text-2xl font-bold backdrop-blur">
              {driver.full_name
                .split(' ')
                .map((s) => s[0])
                .slice(0, 2)
                .join('')}
            </div>
            <div>
              <p className="text-sm text-white/80">{formatPhone(driver.phone)}</p>
              <h1 className="font-display text-2xl font-bold">{driver.full_name}</h1>
              <Badge variant="solid" className="mt-1 bg-white/25 text-white">
                <Star className="h-3 w-3 fill-current" /> {(driver.average_rating ?? 0).toFixed(1)} ·{' '}
                {KYC_PILL[kycStatus] ?? kycStatus}
              </Badge>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 divide-x divide-border text-center">
          <Stat label="Deliveries" value={driver.total_deliveries.toString()} />
          <Stat label="Battery" value={`${driver.battery_level ?? '—'}%`} />
          <Stat label="Rating" value={(driver.average_rating ?? 0).toFixed(1)} />
        </div>
      </Card>

      {/* First thing under the hero: the apply screen sends riders here when a document
          is missing, so the row it wants them to tap must not be below the fold. */}
      <Card className="mt-4 overflow-hidden p-0">
        <button
          type="button"
          onClick={() => router.push('/app/profile/documents')}
          className="focus-ring flex w-full items-center gap-3 p-4 text-left"
        >
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <FileCheck2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Documents &amp; verification</p>
            <p className={`truncate text-xs ${loaded ? SUMMARY_CLASS[stage] : 'text-muted-foreground'}`}>
              {summary}
            </p>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
        </button>
      </Card>

      <Card className="mt-4 p-5">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
            <VehicleIcon className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Vehicle</p>
            <p className="font-display text-base font-semibold capitalize">
              {driver.vehicle_type} · {driver.vehicle_plate ?? '—'}
            </p>
          </div>
        </div>
      </Card>

      <ul className="mt-4 space-y-2">
        <li>
          <button
            onClick={() => router.push('/app/apply')}
            className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left transition-shadow hover:shadow-soft"
          >
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <Building2 className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <p className="font-semibold">Branches I serve</p>
              <p className="text-xs text-muted-foreground">
                {driver.approvals?.filter((a) => a.status === 'approved').length ?? 0} approved
              </p>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </button>
        </li>
        <li>
          <button className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left transition-shadow hover:shadow-soft">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <HeartHandshake className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <p className="font-semibold">Support center</p>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </button>
        </li>
        {/* Renders its own <li>, or nothing when already installed / no install path. */}
        <DriverInstallRow />
        <li>
          <Button
            variant="ghost"
            leftIcon={<LogOut className="h-4 w-4" />}
            onClick={handleSignOut}
            fullWidth
            className="justify-start text-danger hover:bg-danger/5"
          >
            Sign out
          </Button>
        </li>
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-4">
      <p className="font-display text-xl font-bold text-primary">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
