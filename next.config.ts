import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Exclude Prisma from Edge runtime and server components
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
