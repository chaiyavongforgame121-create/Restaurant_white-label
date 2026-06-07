import { getServerClient } from '@favornoms/database/server';
import { Card, EmptyState } from '@favornoms/ui';
import { ClipboardList } from 'lucide-react';

interface Props { params: Promise<{ branchId: string }> }

export default async function ActivityPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: logs } = await supabase
    .from('audit_logs')
    .select('id, action, entity_type, actor_type, created_at, metadata')
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <div className="container max-w-3xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Activity log</h1>
        <p className="mt-1 text-muted-foreground">Audit trail of important actions</p>
      </header>
      {(!logs || logs.length === 0) ? (
        <EmptyState
          icon={<ClipboardList className="h-7 w-7" />}
          title="No activity yet"
          description="Important actions (refunds, void, settings changes) will appear here."
        />
      ) : (
        <ul className="space-y-2 px-2 lg:px-0">
          {logs.map((l) => (
            <li key={l.id}>
              <Card className="p-3 text-sm">
                <div className="flex justify-between">
                  <span className="font-semibold">{l.action}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(l.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {l.actor_type} · {l.entity_type}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
