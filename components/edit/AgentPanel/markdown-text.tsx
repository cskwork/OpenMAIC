'use client';

/**
 * Markdown renderer for assistant message text — uses assistant-ui's
 * MarkdownTextPrimitive so replies render as real markdown (lists, code,
 * emphasis) with proper wrapping, instead of raw text that spills out.
 */
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from '@assistant-ui/react-markdown';
import { cn } from '@/lib/utils/cn';

const components = memoizeMarkdownComponents({
  p: ({ className, ...props }) => (
    <p className={cn('mb-2 leading-relaxed last:mb-0', className)} {...props} />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn('mb-2 list-disc space-y-1 pl-4 last:mb-0', className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn('mb-2 list-decimal space-y-1 pl-4 last:mb-0', className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn('leading-relaxed', className)} {...props} />,
  a: ({ className, ...props }) => (
    <a
      className={cn('font-medium text-primary underline underline-offset-2 hover:opacity-80', className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  strong: ({ className, ...props }) => <strong className={cn('font-semibold', className)} {...props} />,
  h1: ({ className, ...props }) => (
    <h1 className={cn('mb-2 mt-1 text-sm font-semibold', className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn('mb-1.5 mt-1 text-sm font-semibold', className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn('mb-1 mt-1 text-[13px] font-semibold', className)} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn('my-2 border-l-2 border-border pl-3 text-muted-foreground', className)}
      {...props}
    />
  ),
  code: ({ className, ...props }) => (
    <code
      className={cn(
        'rounded bg-muted px-1 py-0.5 font-mono text-[12px] [overflow-wrap:anywhere]',
        className,
      )}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        'my-2 overflow-x-auto rounded-lg bg-muted p-2.5 font-mono text-[12px] leading-relaxed',
        className,
      )}
      {...props}
    />
  ),
});

export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="text-sm text-foreground [overflow-wrap:anywhere]"
      components={components}
    />
  );
}
