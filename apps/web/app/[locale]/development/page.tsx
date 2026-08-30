import { DevelopmentDashboard } from '../../../src/features/development/development-dashboard';
import {
  getDevelopmentRepositories,
  getDevelopmentRuns,
} from '../../../src/features/development/development-data';

export default async function DevelopmentPage() {
  const [runResult, repositoryResult] = await Promise.all([
    getDevelopmentRuns(),
    getDevelopmentRepositories(),
  ]);
  return (
    <DevelopmentDashboard
      runs={runResult.kind === 'ok' ? runResult.data : null}
      repositories={repositoryResult.kind === 'ok' ? repositoryResult.data : null}
    />
  );
}
