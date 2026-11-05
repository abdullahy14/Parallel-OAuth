/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Prevent Next.js from bundling puppeteer-core and @sparticuz/chromium-min
   * into the serverless function. These packages rely on native binaries and
   * must be treated as external dependencies resolved at runtime.
   */
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium-min"],
};

export default nextConfig;
