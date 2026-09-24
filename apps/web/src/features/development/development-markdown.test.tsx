import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DevelopmentMarkdown } from './development-markdown';

function renderMarkdown(source: string) {
  return renderToStaticMarkup(<DevelopmentMarkdown>{source}</DevelopmentMarkdown>);
}

describe('DevelopmentMarkdown', () => {
  it('shows remote image syntax without loading an image', () => {
    const html = renderMarkdown('![tracking](https://example.com/pixel?run=1)');

    expect(html).not.toContain('<img');
    expect(html).toContain('![tracking](https://example.com/pixel?run=1)');
  });

  it('preserves literal code while formatting ordinary Markdown', () => {
    const html = renderMarkdown(
      '**Review plan** before running `git add src/.**generated.ts`.\n\n```sh\ngit add src/.**generated.ts\n```',
    );

    expect(html).toContain('<strong>Review plan</strong>');
    expect(html.match(/git add src\/\.\*\*generated\.ts/g)).toHaveLength(2);
    expect(html).not.toContain('git add src/.** generated.ts');
  });
});
