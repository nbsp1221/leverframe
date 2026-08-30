import { DevelopmentDashboard } from '../../../src/features/development/development-dashboard';
import {
  getDevelopmentRepositories,
  getDevelopmentRuns,
  getDevelopmentTickets,
} from '../../../src/features/development/development-data';

export default async function DevelopmentPage() {
  const [runResult, repositoryResult, ticketResult] = await Promise.all([
    getDevelopmentRuns(),
    getDevelopmentRepositories(),
    getDevelopmentTickets(),
  ]);
  return (
    <DevelopmentDashboard
      runs={runResult.kind === 'ok' ? runResult.data : null}
      repositories={repositoryResult.kind === 'ok' ? repositoryResult.data : null}
      tickets={ticketResult.kind === 'ok' ? ticketResult.data : null}
    />
  );
}
