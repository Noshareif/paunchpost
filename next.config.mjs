/** @type {import('next').NextConfig} */
const nextConfig = {
  // The setup button reads these files at runtime, so ship them with the server code.
  outputFileTracingIncludes: {
    "/api/admin/setup": ["./db/schema.sql", "./data/mailchimp.json"],
  },
};
export default nextConfig;
