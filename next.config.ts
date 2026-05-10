import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // trailingSlash so static export emits e.g. out/session/index.html. Stock
  // nginx serves /session/ → out/session/index.html cleanly without needing
  // try_files configuration. The session URLs already include `?id=…` so a
  // trailing slash on /session/ is the natural form.
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
