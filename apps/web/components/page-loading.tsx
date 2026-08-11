export function PageLoading({ label }: { label: string }) {
  return (
    <main className="dashboard-shell" aria-busy="true" aria-label={`Loading ${label}`}>
      <header className="dashboard-header loading-header">
        <div>
          <span className="loading-line loading-line-short" />
          <span className="loading-line loading-line-title" />
          <span className="loading-line loading-line-summary" />
        </div>
      </header>
      <div className="loading-surface-grid">
        <span className="loading-surface" />
        <span className="loading-surface" />
        <span className="loading-surface" />
      </div>
    </main>
  );
}
