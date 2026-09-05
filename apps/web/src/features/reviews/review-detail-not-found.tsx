import { Button } from '@repo/ui/components/button';
import { getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { ReviewPageFrame } from './review-page-frame';

export async function ReviewDetailNotFoundState({
  returnQuery = '',
}: {
  returnQuery?: string | undefined;
}) {
  const t = await getTranslations('reviewDetail');
  return (
    <ReviewPageFrame className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t('notFoundTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('notFoundDescription')}</p>
      <Button
        nativeButton={false}
        render={<Link href={`/reviews${returnQuery ? `?${returnQuery}` : ''}`} />}
      >
        {t('backToList')}
      </Button>
    </ReviewPageFrame>
  );
}
