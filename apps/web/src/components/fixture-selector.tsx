import { ActivityIcon } from 'lucide-react';
import type { FixtureScenario } from '../fixtures';

export function FixtureSelector({
  scenario,
  label,
  applyLabel,
  scenarios,
}: {
  scenario: FixtureScenario;
  label: string;
  applyLabel: string;
  scenarios: readonly FixtureScenario[];
}) {
  return (
    <form
      method="get"
      className="flex min-h-14 flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-border bg-surface px-4 py-2.5 sm:px-5"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ActivityIcon aria-hidden="true" className="size-4" />
        {label}
      </div>
      <div className="flex items-center gap-2">
        <select
          name="fixture"
          defaultValue={scenario}
          aria-label={label}
          className="h-8 min-w-32 rounded-xl border border-input bg-surface px-3 text-xs font-medium text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {scenarios.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="h-8 rounded-xl bg-surface-subtle px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {applyLabel}
        </button>
      </div>
    </form>
  );
}
