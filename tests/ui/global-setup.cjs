/**
 * global-setup.cjs
 *
 * Playwright globalSetup — runs once before any test worker starts.
 *
 * Starts the FERRET mock API server on FERRET_MOCK_PORT (default: 18000).
 * Port 18000 is chosen to avoid conflicts with the real FERRET API (port 8000).
 *
 * The Next.js UI is started by Playwright's webServer block in
 * playwright.config.cjs with NEXT_PUBLIC_API_URL pointing at this mock server,
 * so all API calls from the UI are intercepted without real network access.
 *
 * The server port is written to a temp file so global-teardown.cjs can read it
 * (global variables are not shared between globalSetup and globalTeardown
 * processes in Playwright).
 *
 * @see global-teardown.cjs
 * @see mock-server-handlers.cjs
 * @see mock-server-contract.cjs
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleRequest } = require('./mock-server-handlers.cjs');

// Temp file used to pass the server port to globalTeardown
const PORT_FILE = path.join(__dirname, '.mock-server-port');

module.exports = async function globalSetup() {
  const port = parseInt(process.env.FERRET_MOCK_PORT || '18000', 10);

  const server = http.createServer(handleRequest);

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(
          `[global-setup] ⚠  Port ${port} already in use — mock server not started.\n` +
          `  Tests will use whatever is running at 127.0.0.1:${port}.\n` +
          `  If another test run is active, wait for it to finish or set FERRET_MOCK_PORT to a free port.\n`,
        );
        resolve();
      } else {
        reject(err);
      }
    });
  });

  // Store the server instance so teardown can close it.
  // We use a global on the process object as a cross-process-safe workaround.
  global.__FERRET_MOCK_SERVER__ = server;

  // Write port to temp file for teardown
  fs.writeFileSync(PORT_FILE, String(port), 'utf8');

  process.stdout.write(
    `[global-setup] ✓ Mock API server listening on http://127.0.0.1:${port}\n`,
  );
};
