export default function RootLoading() {
  return (
    <div className="grid min-h-dynamic-screen place-items-center">
      <div className="flex flex-col items-center gap-3">
        <span className="h-12 w-12 animate-spin rounded-full border-4 border-muted border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    </div>
  );
}
