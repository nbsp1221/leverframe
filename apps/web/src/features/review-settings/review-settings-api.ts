import {
  type ReviewModelSettings,
  reviewSettingsResponseSchema,
} from '@repo/contracts/review-settings';

export async function requestReviewSettings(settings?: ReviewModelSettings) {
  const response = await fetch('/api/v1/settings/reviews', {
    cache: 'no-store',
    ...(settings === undefined
      ? {}
      : {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(settings),
        }),
  });
  if (!response.ok) {
    throw new Error(`review_settings_http_${response.status}`);
  }
  return reviewSettingsResponseSchema.parse(await response.json());
}
