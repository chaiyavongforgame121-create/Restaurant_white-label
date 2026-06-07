import { Bike, Calendar } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';

const items = [
  { id: 1, date: 'Today · 1:42 PM', from: 'Coastal Grill — Brooklyn', to: 'Bedford Ave 240', amount: 8.5, status: 'Delivered' },
  { id: 2, date: 'Today · 12:15 PM', from: 'Bella Burger — Williamsburg', to: 'N 5th St 52', amount: 9.2, status: 'Delivered' },
  { id: 3, date: 'Today · 11:28 AM', from: 'Brooklyn Bistro', to: 'Driggs Ave 100', amount: 7.8, status: 'Delivered' },
  { id: 4, date: 'Yesterday · 7:33 PM', from: 'Coastal Grill — Brooklyn', to: 'Grand St 88', amount: 11.0, status: 'Delivered' },
  { id: 5, date: 'Yesterday · 6:50 PM', from: 'Cedar Tavern', to: 'Metropolitan Ave 220', amount: 9.5, status: 'Delivered' },
];

export default function HistoryPage() {
  return (
    <div className="px-4 pt-6">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold">History</h1>
        <button className="focus-ring inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-2 text-sm font-medium">
          <Calendar className="h-4 w-4" /> This week
        </button>
      </header>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id}>
            <Card className="p-4">
              <div className="flex items-start gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Bike className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">{item.date}</p>
                    <span className="font-display text-lg font-bold text-primary">
                      {formatCurrency(item.amount)}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-semibold">{item.from}</p>
                  <p className="text-sm text-muted-foreground">→ {item.to}</p>
                </div>
              </div>
              <Badge variant="success" className="mt-3">{item.status}</Badge>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
