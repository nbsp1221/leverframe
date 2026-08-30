import { DevelopmentDashboard } from '../../../src/features/development/development-dashboard';
import { getDevelopmentRuns } from '../../../src/features/development/development-data';

export default async function DevelopmentPage() {
  const result = await getDevelopmentRuns();
  return (
    <DevelopmentDashboard
      runs={result.kind === 'ok' ? result.data : null}
      repository={process.env.DEVELOPMENT_REPOSITORY ?? ''}
    />
  );
}
