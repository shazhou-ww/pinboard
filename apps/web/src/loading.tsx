export function LoadingIndicator({
  label,
  compact = false,
}: {
  readonly label: string;
  readonly compact?: boolean;
}) {
  return (
    <div
      className={`loading-indicator${compact ? " loading-indicator-compact" : ""}`}
      role="status"
      aria-label={label}
    >
      <span className="loading-spinner" aria-hidden="true" />
    </div>
  );
}
