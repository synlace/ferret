/**
 * mock-server-handlers.cjs
 *
 * HTTP request handler for the FERRET mock API server.
 *
 * Intercepts all API calls the UI makes to http://localhost:8000 during tests.
 * The mock server runs on FERRET_MOCK_PORT (default: 18000) and is started by
 * global-setup.cjs before any test worker runs.
 *
 * IMPORTANT: Always update mock-server-contract.cjs first when changing
 * endpoints. This file must match the contract.
 *
 * Responses are minimal but structurally valid — enough for the UI to render
 * without errors.
 */

'use strict';

const TEMP_PROJECT = {
  id: 'temp',
  name: 'Temp Workspace',
  description: 'Default temporary project',
  color: '#f97316',
  emoji: '🔥',
  labels: [],
  default_model: 'google/gemini-flash-1.5',
  is_temp: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const PROXY_STATUS = {
  running: true,
  uptime: 0,
  listen_address: '127.0.0.1:1337',
  intercepted: 0,
};

const MOCK_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIBpDCCAQqgAwIBAgIUFakeTestCertForFerretUITests0DQYJKoZIhvcNAQEL
BQAwETEPMA0GA1UEAxMGRkFSVENBMB4XDTIzMDEwMTAwMDAwMFoXDTI0MDEwMTAw
MDAwMFowETEPMA0GA1UEAxMGRkFSVENBMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCB
iQKBgQC7fake+test+cert+data+for+ferret+ui+tests+only==
-----END CERTIFICATE-----
`;

// In-memory chat session store (reset per server start)
const chatSessions = new Map();

// In-memory workspace file store: Map<sessionId, Map<filePath, {content, size, modified_at}>>
const workspaceFiles = new Map();

// A seeded session used by tests that need a pre-existing session
const SEEDED_SESSION = {
  id: 'session-seeded-001',
  name: 'Seeded Test Session',
  scope: 'all',
  scope_data: null,
  workspace_dir: 'temp/session-seeded-001',
  created_at: '2024-06-01T10:00:00Z',
};

// A seeded HTTP request used by history interaction tests
const SEEDED_REQUEST = {
  seq: 1,
  id: 'req-seeded-001',
  timestamp: '2024-06-01T10:00:00Z',
  method: 'GET',
  url: 'https://example.com/api/users',
  host: 'example.com',
  path: '/api/users',
  status_code: 200,
  response_time: 42,
  response_size: 512,
  headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  body: null,
  response_headers: { 'Content-Type': 'application/json' },
  response_body: '{"users":[]}',
  annotation: null,
  source: 'proxy',
};

// A second seeded request for filtering/sorting tests
const SEEDED_REQUEST_2 = {
  seq: 2,
  id: 'req-seeded-002',
  timestamp: '2024-06-01T11:00:00Z',
  method: 'POST',
  url: 'https://api.target.com/login',
  host: 'api.target.com',
  path: '/login',
  status_code: 404,
  response_time: 120,
  response_size: 64,
  headers: { 'Content-Type': 'application/json' },
  body: '{"username":"test"}',
  response_headers: { 'Content-Type': 'application/json' },
  response_body: '{"error":"not found"}',
  annotation: null,
  source: 'proxy',
};

/**
 * Route the incoming request and write the appropriate mock response.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // ── CORS preflight ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Health ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/health') {
    return json(res, 200, { status: 'ok' });
  }

  // ── Proxy status ────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/proxy/status') {
    return json(res, 200, PROXY_STATUS);
  }

  if (method === 'POST' && path === '/api/proxy/start') {
    return json(res, 200, { message: 'Proxy started successfully' });
  }

  if (method === 'POST' && path === '/api/proxy/stop') {
    return json(res, 200, { message: 'Proxy stopped successfully' });
  }

  if (method === 'GET' && path === '/api/proxy/settings') {
    return json(res, 200, {
      host: '127.0.0.1',
      port: 1337,
      intercept_enabled: false,
      intercept_rules: [],
    });
  }

  // ── Projects ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/projects') {
    return json(res, 200, [TEMP_PROJECT]);
  }

  if (method === 'POST' && path === '/api/projects') {
    return withBody(req, (body) => {
      const project = {
        ...TEMP_PROJECT,
        id: 'proj-' + Date.now(),
        name: body.name || 'New Project',
        is_temp: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      json(res, 201, project);
    });
  }

  if (method === 'DELETE' && path === '/api/projects/all') {
    return json(res, 200, { message: 'All projects deleted' });
  }

  // Project spend
  const projectSpendMatch = path.match(/^\/api\/projects\/([^/]+)\/spend$/);
  if (projectSpendMatch && method === 'GET') {
    return json(res, 200, { total_usd: 0.0012, breakdown: [] });
  }

  // Project keys
  const projectKeysMatch = path.match(/^\/api\/projects\/([^/]+)\/keys$/);
  if (projectKeysMatch) {
    if (method === 'GET') return json(res, 200, []);
    if (method === 'POST') return withBody(req, () => json(res, 201, { id: 'key-001', preview: 'sk-...test' }));
  }

  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const id = projectMatch[1];
    if (method === 'GET') {
      return json(res, 200, { ...TEMP_PROJECT, id });
    }
    if (method === 'PUT' || method === 'PATCH') {
      return withBody(req, (body) => {
        json(res, 200, { ...TEMP_PROJECT, id, ...body });
      });
    }
    if (method === 'DELETE') {
      return json(res, 200, { message: 'Project deleted' });
    }
  }

  // ── Requests (HTTP history) ──────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/requests') {
    // Check for ?seeded=true query param to return test data
    const seeded = url.searchParams.get('seeded');
    if (seeded === 'two') {
      res.setHeader('X-Total-Count', '2');
      return json(res, 200, [SEEDED_REQUEST_2, SEEDED_REQUEST]);
    }
    if (seeded === 'one') {
      res.setHeader('X-Total-Count', '1');
      return json(res, 200, [SEEDED_REQUEST]);
    }
    res.setHeader('X-Total-Count', '0');
    return json(res, 200, []);
  }

  if (method === 'DELETE' && path === '/api/requests') {
    return json(res, 200, { message: 'History cleared' });
  }

  // Individual request endpoints
  const requestAnnotateMatch = path.match(/^\/api\/requests\/([^/]+)\/annotate$/);
  if (requestAnnotateMatch && method === 'POST') {
    return json(res, 200, { annotation: 'Mock AI annotation: GET /api/users — fetches user list, returns 200 OK.' });
  }

  const requestChatMatch = path.match(/^\/api\/requests\/([^/]+)\/chat$/);
  if (requestChatMatch) {
    if (method === 'GET') return json(res, 200, { messages: [] });
    if (method === 'DELETE') return json(res, 200, { message: 'Chat cleared' });
  }

  const requestMatch = path.match(/^\/api\/requests\/([^/]+)$/);
  if (requestMatch) {
    const id = requestMatch[1];
    if (method === 'GET') {
      if (id === SEEDED_REQUEST.id) return json(res, 200, SEEDED_REQUEST);
      if (id === SEEDED_REQUEST_2.id) return json(res, 200, SEEDED_REQUEST_2);
      return json(res, 404, { detail: 'Not found' });
    }
    if (method === 'DELETE') {
      return json(res, 200, { message: 'Request deleted' });
    }
  }

  // ── Findings ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/findings') {
    return json(res, 200, []);
  }

  // ── Tests ────────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/tests') {
    return json(res, 200, []);
  }

  if (method === 'GET' && path === '/api/tests/files') {
    return json(res, 200, { files: [] });
  }

  // ── Settings / CA cert ───────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/ca-cert') {
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="ferret-ca-cert.pem"');
    res.writeHead(200);
    res.end(MOCK_CA_CERT);
    return;
  }

  // ── Repeater ─────────────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/repeater/send') {
    return withBody(req, () => json(res, 200, { message: 'Sent' }));
  }

  if (method === 'GET' && path === '/api/repeater/current') {
    return json(res, 404, { detail: 'No current request' });
  }

  // ── Chats ────────────────────────────────────────────────────────────────────

  // List sessions — optionally return seeded session
  if (method === 'GET' && path === '/api/chats') {
    const seeded = url.searchParams.get('seeded');
    if (seeded === 'one') {
      return json(res, 200, [SEEDED_SESSION]);
    }
    // Return in-memory sessions plus any seeded ones
    const sessions = Array.from(chatSessions.values());
    return json(res, 200, sessions);
  }

  // Create session
  if (method === 'POST' && path === '/api/chats') {
    return withBody(req, (body) => {
      const id = 'session-' + Date.now();
      const session = {
        id,
        name: body.name || 'New Workspace',
        scope: body.scope || 'blank',
        scope_data: body.scope_data ?? null,
        workspace_dir: `temp/${id}`,
        created_at: new Date().toISOString(),
      };
      chatSessions.set(session.id, session);
      workspaceFiles.set(session.id, new Map());
      json(res, 201, session);
    });
  }

  // Session messages — GET (load history)
  const chatMessagesMatch = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (chatMessagesMatch && method === 'GET') {
    const sessionId = chatMessagesMatch[1];
    // Return seeded messages for the seeded session
    if (sessionId === SEEDED_SESSION.id) {
      return json(res, 200, {
        messages: [
          { role: 'user', content: 'Hello from history', timestamp: '10:00' },
          { role: 'assistant', content: 'Hi! I am the mock assistant.', timestamp: '10:00' },
        ],
      });
    }
    return json(res, 200, { messages: [] });
  }

  // Session messages — POST stream (send a message)
  const chatStreamMatch = path.match(/^\/api\/chats\/([^/]+)\/messages\/stream$/);
  if (chatStreamMatch && method === 'POST') {
    return withBody(req, (body) => {
      const userContent = body.message || 'Hello';
      // Respond with a minimal SSE stream: one delta chunk then done
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.writeHead(200);

      const assistantReply = `Mock reply to: "${userContent}"`;
      const donePayload = {
        type: 'done',
        messages: [
          { role: 'user', content: userContent },
          { role: 'assistant', content: assistantReply },
        ],
      };

      // Send a delta event then the done event
      res.write(`data: ${JSON.stringify({ type: 'delta', content: assistantReply })}\n\n`);
      res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
      res.end();
    });
    return;
  }

  // Delete session
  const chatDeleteMatch = path.match(/^\/api\/chats\/([^/]+)$/);
  if (chatDeleteMatch && method === 'DELETE') {
    const sessionId = chatDeleteMatch[1];
    chatSessions.delete(sessionId);
    workspaceFiles.delete(sessionId);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Workspaces ────────────────────────────────────────────────────────────────

  // GET /api/workspaces/{sessionId}/files — list file tree
  const workspaceFilesMatch = path.match(/^\/api\/workspaces\/([^/]+)\/files$/);
  if (workspaceFilesMatch && method === 'GET') {
    const sessionId = workspaceFilesMatch[1];
    const isKnown = sessionId === SEEDED_SESSION.id || chatSessions.has(sessionId);
    if (!isKnown) return json(res, 404, { detail: 'Workspace not found' });

    const files = workspaceFiles.get(sessionId) || new Map();
    const entries = Array.from(files.entries()).map(([filePath, meta]) => ({
      path: filePath,
      subdir: filePath.split('/')[0],
      name: filePath.split('/').pop(),
      size: meta.size,
      modified_at: meta.modified_at,
    }));
    return json(res, 200, { session_id: sessionId, files: entries });
  }

  // Workspace file operations: read, write, delete, run
  // Match /api/workspaces/{sessionId}/files/{filePath...}
  // and optionally /api/workspaces/{sessionId}/files/{filePath...}/run
  const workspaceFileRunMatch = path.match(/^\/api\/workspaces\/([^/]+)\/files\/(.+)\/run$/);
  if (workspaceFileRunMatch && method === 'POST') {
    const sessionId = workspaceFileRunMatch[1];
    const filePath = workspaceFileRunMatch[2];
    const isKnown = sessionId === SEEDED_SESSION.id || chatSessions.has(sessionId);
    if (!isKnown) return json(res, 404, { detail: 'Workspace not found' });

    const files = workspaceFiles.get(sessionId) || new Map();
    if (!files.has(filePath)) return json(res, 404, { detail: 'File not found' });

    const subdir = filePath.split('/')[0];
    if (subdir === 'notes') return json(res, 400, { detail: 'Notes files cannot be run' });

    const runId = 'run-' + Date.now();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.writeHead(200);
    res.write(`data: {"run_id": "${runId}", "status": "running"}\n\n`);
    res.write(`data: {"line": "mock output line 1"}\n\n`);
    res.write(`data: {"line": "mock output line 2"}\n\n`);
    res.write(`data: {"run_id": "${runId}", "status": "passed", "exit_code": 0}\n\n`);
    res.end();
    return;
  }

  const workspaceFileMatch = path.match(/^\/api\/workspaces\/([^/]+)\/files\/(.+)$/);
  if (workspaceFileMatch) {
    const sessionId = workspaceFileMatch[1];
    const filePath = workspaceFileMatch[2];
    const isKnown = sessionId === SEEDED_SESSION.id || chatSessions.has(sessionId);
    if (!isKnown) return json(res, 404, { detail: 'Workspace not found' });

    // Ensure the session has a file store
    if (!workspaceFiles.has(sessionId)) workspaceFiles.set(sessionId, new Map());
    const files = workspaceFiles.get(sessionId);

    if (method === 'GET') {
      if (!files.has(filePath)) return json(res, 404, { detail: 'File not found' });
      const meta = files.get(filePath);
      return json(res, 200, {
        path: filePath,
        content: meta.content,
        size: meta.size,
        modified_at: meta.modified_at,
      });
    }

    if (method === 'PUT') {
      return withBody(req, (body) => {
        const content = body.content || '';
        const subdir = filePath.split('/')[0];
        const ALLOWED = ['scripts', 'tests', 'notes'];
        if (!ALLOWED.includes(subdir)) {
          return json(res, 400, { detail: `File must be under one of: ${ALLOWED.join(', ')}` });
        }
        const now = new Date().toISOString();
        files.set(filePath, { content, size: content.length, modified_at: now });
        json(res, 200, { path: filePath, size: content.length, modified_at: now });
      });
    }

    if (method === 'DELETE') {
      if (!files.has(filePath)) return json(res, 404, { detail: 'File not found' });
      files.delete(filePath);
      return json(res, 200, { deleted: filePath });
    }
  }

  // ── Fallback ─────────────────────────────────────────────────────────────────
  return json(res, 404, { detail: `Mock: no handler for ${method} ${path}` });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(payload);
}

function withBody(req, cb) {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(data); } catch (_) {}
    cb(body);
  });
}

module.exports = { handleRequest };
