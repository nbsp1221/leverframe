import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig = {
  output: 'standalone' as const,
  allowedDevOrigins: ['localhost', '127.0.0.1', '100.80.10.10'],
};

export default withNextIntl(nextConfig);
