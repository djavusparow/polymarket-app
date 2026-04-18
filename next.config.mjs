/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
  // ethers v6 ships ESM-only — tell Next.js to transpile it for Node.js API routes
  transpilePackages: ['ethers'],
  serverExternalPackages: [],
}

export default nextConfig
