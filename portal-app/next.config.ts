import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "@huggingface/transformers",
    "@modelcontextprotocol/sdk",
    "iron-session",
    "onnxruntime-node",
    "postgres",
  ],
};

export default nextConfig;
