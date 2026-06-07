'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Bike, Building2, CheckCircle2, ChevronRight, FileCheck2,
  HeartHandshake, LogOut, ShieldAlert, Star, Upload,
} from 'lucide-react';
import { Badge, Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useDriverSession } from '@/components/driver-session';

const DOC_TYPES = [
  { key: 'national_id', label: 'National ID card' },
  { key: 'license_front', label: 'Driver license — front' },
  { key: 'license_back', label: 'Driver license — back' },
  { key: 'vehicle_reg', label: 'Vehicle registration' },
  { key: 'selfie', label: 'Selfie with ID' },
] as const;

type DocKey = (typeof DOC_TYPES)[number]['key'];

export function ProfileView() {
  const { driver, refresh } = useDriverSession();
  const router = useRouter();
  const [uploadedDocs, setUploadedDocs] = React.useState<Set<DocKey>>(new Set());

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase.storage
      .from('driver-kyc')
      .list(driver.id, { limit: 50 })
      .then(({ data }) => {
        if (!data) return;
        const found = new Set<DocKey>();
        for (const f of data) {
          const base = f.name.split('.')[0] as DocKey;
          if (DOC_TYPES.some((d) => d.key === base)) found.add(base);
        }
        setUploadedDocs(found);
      });
  }, [driver.id]);

  const kycStatus = driver.kyc_status ?? 'pending';
  const isVerified = kycStatus === 'verified';
  const isRejected = kycStatus === 'rejected' || kycStatus === 'suspended';

  const uploadDoc = async (docKey: DocKey, file: File) => {
    const supabase = getBrowserClient();
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
    const path = `${driver.id}/${docKey}.${ext}`;
    const { error } = await supabase.storage
      .from('driver-kyc')
      .upload(path, file, { upsert: true, contentType: file.type });
    if (error) {
      alert(`Upload failed: ${error.message}`);
      return;
    }
    setUploadedDocs((s) => new Set(s).add(docKey));
  };

  const handleSignOut = async () => {
    const supabase = getBrowserClient();
    await supabase.auth.signOut();
    router.replace('/login');
  };

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
              <p className="text-sm text-white/80">{driver.phone}</p>
              <h1 className="font-display text-2xl font-bold">{driver.full_name}</h1>
              <Badge variant="solid" className="mt-1 bg-white/25 text-white">
                <Star className="h-3 w-3 fill-current" /> {(driver.average_rating ?? 0).toFixed(1)} ·{' '}
                {kycStatus}
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

      <Card className="mt-4 p-5">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Bike className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Vehicle</p>
            <p className="font-display text-base font-semibold capitalize">
              {driver.vehicle_type} · {driver.vehicle_plate ?? '—'}
            </p>
          </div>
        </div>
      </Card>

      <section className="mt-4">
        <Card className="overflow-hidden">
          <header
            className={`flex items-center gap-3 px-5 py-4 ${
              isVerified
                ? 'bg-success/10 text-success'
                : isRejected
                  ? 'bg-danger/10 text-danger'
                  : 'bg-warning/10 text-warning'
            }`}
          >
            {isVerified ? (
              <CheckCircle2 className="h-6 w-6" />
            ) : (
              <ShieldAlert className="h-6 w-6" />
            )}
            <div>
              <p className="font-display text-base font-semibold capitalize">{kycStatus}</p>
              <p className="text-xs">
                {isVerified
                  ? 'Your documents are verified. You can receive dispatches.'
                  : isRejected
                    ? 'KYC was rejected — please re-upload and contact support.'
                    : 'Upload all five documents to start receiving dispatches.'}
              </p>
            </div>
          </header>

          <ul className="divide-y divide-border">
            {DOC_TYPES.map((doc) => {
              const done = uploadedDocs.has(doc.key);
              return (
                <li key={doc.key} className="flex items-center gap-3 px-5 py-3">
                  <div
                    className={`grid h-10 w-10 place-items-center rounded-xl ${
                      done ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {done ? <CheckCircle2 className="h-5 w-5" /> : <FileCheck2 className="h-5 w-5" />}
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold">{doc.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {done ? 'Uploaded — pending review' : 'Not uploaded'}
                    </p>
                  </div>
                  <label className="focus-ring inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-semibold text-primary-foreground">
                    <Upload className="h-3.5 w-3.5" />
                    {done ? 'Replace' : 'Upload'}
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadDoc(doc.key, file).then(() => refresh());
                      }}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

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
