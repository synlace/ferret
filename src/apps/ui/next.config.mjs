/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Allow tests to use a separate build directory (e.g. .next-test) so that
  // running `just test ui` while `just dev` is active does not overwrite the
  // dev build cache with a mock-API-URL baked-in build.
  // Set NEXT_DIST_DIR=.next-test in the test webServer command to activate.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  experimental: {
    outputFileTracingRoot: process.cwd(),
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
