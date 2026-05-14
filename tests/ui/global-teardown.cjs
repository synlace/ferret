/**
 * global-teardown.cjs
 *
 * Playwright globalTeardown — runs once after all test workers finish.
 *
 * Stops the FERRET mock API server that was started by global-setup.cjs.
 *
 * @see global-setup.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PORT_FILE = path.join(__dirname, '.mock-server-port');

module.exports = async function globalTeardown() {
  // The server instance is on the global (same process as globalSetup in
  // Playwright's default runner). If it's not there, nothing to do.
  const server = global.__FERRET_MOCK_SERVER__;

  if (server) {
    await new Promise((resolve) => server.close(resolve));
    process.stdout.write('[global-teardown] ✓ Mock API server stopped.\n');
  }

  // Clean up temp file
  try {
    fs.unlinkSync(PORT_FILE);
  } catch (_) {
    // ignore — file may not exist if setup failed
  }
};
