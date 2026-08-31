import { getDevelopmentRun } from '../../../../src/features/development/development-data';
import { DevelopmentDetailView } from '../../../../src/features/development/development-detail';
import { redirect } from '../../../../src/i18n/navigation';

export default async function DevelopmentRunPage({
  params,
}: {
  params: Promise<{ locale: string; runId: string }>;
}) {
  const { locale, runId } = await params;
  const id = Number(runId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    redirect({ href: '/development', locale });
  }
  const result = await getDevelopmentRun(id);
  if (result.kind === 'ok') {
    return <DevelopmentDetailView detail={result.data} />;
  }
  redirect({ href: '/development', locale });
}
