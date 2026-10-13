import createMiddleware from 'next-intl/middleware';
import { type NextRequest, NextResponse } from 'next/server';
import { routing } from './src/i18n/routing';

const handleI18nRouting = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/') {
    return NextResponse.redirect(new URL('/en/reviews', request.url));
  }
  return handleI18nRouting(request);
}

export const config = {
  matcher: ['/((?!api|trpc|_next|_vercel|healthz|setup/github|docs|.*\\..*).*)'],
};
