import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocalTime } from './local-time';

describe('LocalTime', () => {
  it('keeps the server-rendered timestamp independent of its time zone', () => {
    const value = '2026-08-30T11:14:00.000Z';
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}}>
        <LocalTime value={value} />
      </NextIntlClientProvider>,
    );

    expect(html).toContain(`dateTime="${value}"`);
    expect(html).toContain('>—</time>');
    expect(html).not.toContain('>11:14');
  });
});
