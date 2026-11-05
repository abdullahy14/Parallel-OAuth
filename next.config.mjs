/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Prevent Next.js from bundling puppeteer-core and @sparticuz/chromium-min
   * into the serverless function. These packages rely on native binaries and
   * must be treated as external dependencies resolved at runtime.
   *
   * In Next.js 14.1+ this is `serverExternalPackages` (stable).
   * For older 14.x builds that only expose the experimental flag,
   * both keys are set so the config works across patch releases.
   */
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium-min"],

  experimental: {
    serverComponentsExternalPackages: ["puppeteer-core", "@sparticuz/chromium-min"],
  },
};

export default nextConfig;
