import { describe, expect, it } from 'vitest';
import { connectionSettingsHref, settingsReturnPath } from './settings-navigation';

describe('settings return navigation', () => {
  it('preserves the selected request and filters through a settings URL', () => {
    const origin = '/decisions?request=dr-1&view=progress&q=some%20work';
    const url = new URL(connectionSettingsHref(origin), 'https://leverframe.invalid');
    expect(settingsReturnPath(url.searchParams.get('returnTo'))).toBe(origin);
  });
  it.each([
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/settings/connections',
    '/reviews/../../settings',
    '/reviews-extra',
    undefined,
  ])('rejects external or unrelated destinations: %s', (value) => {
    expect(settingsReturnPath(value)).toBe('/decisions');
  });
});
