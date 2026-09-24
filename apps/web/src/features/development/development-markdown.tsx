import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap text-sm leading-6">{children}</p>,
  h1: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc pl-5 text-sm leading-6">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 text-sm leading-6">{children}</ol>,
  li: ({ children }) => <li className="my-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="max-w-full overflow-x-auto rounded-lg bg-surface-subtle p-3 text-xs">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-surface-subtle px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
  img: ({ src, alt }) => (
    <code className="rounded bg-surface-subtle px-1 py-0.5 font-mono text-xs">
      {`![${alt ?? ''}](${typeof src === 'string' ? src : ''})`}
    </code>
  ),
  a: ({ href, children }) =>
    href?.startsWith('https://') || href?.startsWith('http://') ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-link underline-offset-2 hover:underline"
      >
        {children}
      </a>
    ) : (
      <code className="rounded bg-surface-subtle px-1 py-0.5 font-mono text-xs">
        {href || children}
      </code>
    ),
};

export function DevelopmentMarkdown({ children }: { children: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 break-words">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </div>
  );
}
