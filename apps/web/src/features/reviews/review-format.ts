export function formatDuration(value: number | null): string {
  if (value === null) {
    return '—';
  }
  const seconds = Math.round(value / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
