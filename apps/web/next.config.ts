import type { NextConfig } from 'next'

const config: NextConfig = {
  transpilePackages: ['@zecca/contracts', '@zecca/xrpl-core'],
  reactStrictMode: true,
  // The API runs separately (services/api). The web calls it at NEXT_PUBLIC_API_ORIGIN.
}
export default config
