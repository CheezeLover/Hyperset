import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "@modelcontextprotocol/sdk",
    "iron-session",
  ],
};

export default nextConfig;
