/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  experimental: {
    // public/ is served by the CDN and is not otherwise traced into a
    // serverless function's filesystem. The payment-link email reads
    // the logo at request time to attach it by CID, so it has to be
    // included explicitly or that read finds nothing in production.
    outputFileTracingIncludes: {
      '/api/send-payment-link': ['./public/mcc-logo.jpg'],
    },
  },
};
