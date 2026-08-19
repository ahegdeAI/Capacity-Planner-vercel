// Vercel serverless entry point. Vercel's Node.js runtime accepts an Express
// app instance directly as a request handler, so this is normally
// sufficient — no .listen() needed (and none is called anywhere in
// server/app.js). See vercel.json for the rewrite that routes /api/* here.
module.exports = require("../server/app");
