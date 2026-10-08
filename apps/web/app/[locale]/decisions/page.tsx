import { Suspense } from 'react';
import { DecisionWorkspace } from '../../../src/features/decisions/decision-workspace';

export default function DecisionsPage() {
  return (
    <Suspense>
      <DecisionWorkspace />
    </Suspense>
  );
}
