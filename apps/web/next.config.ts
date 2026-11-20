import type { NextConfig } from 'next'

const config: NextConfig = {
  transpilePackages: ['@zecca/contracts', '@zecca/xrpl-core'],
  reactStrictMode: true,
  devIndicators: false,
  // Lets the dev server answer through a cloudflared quick tunnel (phone tests, remote preview). Dev only.
  allowedDevOrigins: ['*.trycloudflare.com'],
  // The API runs separately (services/api). The web calls it at NEXT_PUBLIC_API_ORIGIN.
  turbopack: {
    // xrpl-connect ships a bundle with UMD wrappers (crypto-js) whose AMD branch names "./core". That branch never
    // runs in a browser (no global define), but Turbopack tries to resolve it. Ignore only that issue, only there.
    ignoreIssue: [{ path: /xrpl-connect\/xrpl-connect\.mjs$/, title: /Module not found/ }],
  },
}
export default config
