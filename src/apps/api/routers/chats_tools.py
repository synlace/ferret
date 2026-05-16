"""
Agentic tool definitions available in session chat.

Each entry follows the OpenAI function-calling schema.  A ``rationale``
property is injected into every tool at module load time so the model always
explains why it is calling the tool (visible in the UI as a sub-panel).
"""

from typing import List, Dict, Any

# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

SESSION_CHAT_TOOLS: List[Dict[str, Any]] = [
    # -----------------------------------------------------------------------
    # Proxy history tools
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "search_requests",
            "description": (
                "Search the proxy request history by keyword. "
                "Returns a list of matching requests (method, URL, status). "
                "Use this first to discover what endpoints exist."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keyword to match against URL, host, or body. Leave empty to list all.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results to return (default 20).",
                        "default": 20,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_request_detail",
            "description": (
                "Fetch the full details of a single HTTP request by its ID, "
                "including request headers, body, response headers, and response body. "
                "Use this to inspect a specific request before writing a test."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "request_id": {
                        "type": "string",
                        "description": "The request ID (from search_requests results).",
                    },
                },
                "required": ["request_id"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # Findings tools
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "create_finding",
            "description": (
                "Create a security finding in the FERRET findings database. "
                "Use this when you have confirmed or strongly suspected a vulnerability. "
                "Returns the created finding ID."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title, e.g. 'SQL Injection in /api/login'.",
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["critical", "high", "medium", "low", "info"],
                        "description": "Severity level.",
                    },
                    "type": {
                        "type": "string",
                        "enum": ["sqli", "xss", "idor", "auth", "config", "other"],
                        "description": "Vulnerability type.",
                        "default": "other",
                    },
                    "host": {
                        "type": "string",
                        "description": "Affected host, e.g. 'example.com'.",
                    },
                    "description": {
                        "type": "string",
                        "description": "Detailed description of the vulnerability.",
                    },
                    "evidence": {
                        "type": "string",
                        "description": "Evidence or proof-of-concept (request/response snippets, test output).",
                    },
                    "request_id": {
                        "type": "string",
                        "description": "Optional: ID of the associated proxy request.",
                    },
                },
                "required": ["title", "severity", "host", "description"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_findings",
            "description": (
                "List existing security findings for the current project. "
                "Use this to avoid creating duplicate findings and to reference prior work."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "severity": {
                        "type": "string",
                        "enum": ["critical", "high", "medium", "low", "info"],
                        "description": "Filter by severity (optional).",
                    },
                    "status": {
                        "type": "string",
                        "enum": ["open", "confirmed", "false_positive", "fixed"],
                        "description": "Filter by status (optional).",
                    },
                },
                "required": [],
            },
        },
    },
    # -----------------------------------------------------------------------
    # Test execution tools
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "write_test",
            "description": (
                "Write a complete Python pytest file to disk and immediately execute it. "
                "Returns the raw pytest output. Use this to create structured, reusable "
                "security tests for endpoints discovered in the proxy history."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Filename for the test file, e.g. test_login_sqli.py",
                    },
                    "code": {
                        "type": "string",
                        "description": "Complete Python pytest source code.",
                    },
                },
                "required": ["filename", "code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_test",
            "description": "Run an existing pytest file by filename. Returns pytest output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Filename of the test to run.",
                    }
                },
                "required": ["filename"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_test",
            "description": (
                "Read the current contents of an existing pytest file. "
                "Use this before modifying a test — read it first, fix only the broken part, "
                "then overwrite it with write_test using the SAME filename. "
                "Never create _v2, _v3 variants — always reuse the original filename."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Filename of the test file to read, e.g. test_ws_xss.py",
                    }
                },
                "required": ["filename"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pip_install",
            "description": (
                "Install one or more Python packages into the ferret-lab sandbox environment "
                "using pip3. Use this when a test fails with ModuleNotFoundError. "
                "Packages persist in the sandbox until it is restarted. "
                "Prefer packages already available (requests, httpx, websockets, "
                "websocket-client, pytest, paramiko, cryptography). "
                "Only use this when a ModuleNotFoundError occurs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "packages": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of package names to install, e.g. ['websocket-client', 'paramiko']",
                    }
                },
                "required": ["packages"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # Script execution tool
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "run_script",
            "description": (
                "Write and execute an arbitrary bash or Python script in the ferret-lab sandbox. "
                "Use this to run exploit PoCs, custom scanners, or any shell command that "
                "doesn't fit into write_pytest_file. "
                "The script runs inside the sandbox container with network access. "
                "stdout + stderr are returned (truncated to 8 KB). "
                "For Python scripts use interpreter='python3'; for shell use interpreter='bash'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "interpreter": {
                        "type": "string",
                        "enum": ["bash", "python3"],
                        "description": "Interpreter to use: 'bash' or 'python3'.",
                    },
                    "script": {
                        "type": "string",
                        "description": "Full script source code to execute.",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Execution timeout in seconds (default 30, max 120).",
                    },
                },
                "required": ["interpreter", "script"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # katana web crawler — preferred for endpoint/directory discovery
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "run_katana",
            "description": (
                "Crawl a web application to discover endpoints, paths, forms, and linked resources. "
                "PREFER this over run_ffuf for directory/file/endpoint discovery — katana follows "
                "real links and parses JavaScript, finding routes that wordlist fuzzing misses. "
                "Use run_ffuf only for parameter fuzzing, credential brute-forcing, or SQLi fuzzing.\n"
                "Results are truncated to 16 KB."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Seed URL to start crawling from, e.g. 'https://target.com'.",
                    },
                    "depth": {
                        "type": "integer",
                        "description": "Crawl depth (default 3, max 10).",
                    },
                    "js_crawl": {
                        "type": "boolean",
                        "description": "Parse JavaScript files for additional endpoints (default true).",
                    },
                    "headless": {
                        "type": "boolean",
                        "description": (
                            "Use headless Chrome to render JS-heavy SPAs before crawling "
                            "(default false — slower but finds dynamically-rendered routes)."
                        ),
                    },
                    "scope": {
                        "type": "string",
                        "description": (
                            "Restrict crawl to URLs matching this regex. "
                            "Defaults to the seed domain. Use '.*' to crawl out-of-scope links."
                        ),
                    },
                    "proxy": {
                        "type": "string",
                        "description": "Proxy URL (default 'http://api:1337' to route through FERRET).",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Total execution timeout in seconds (default 60, max 300).",
                    },
                    "extra_args": {
                        "type": "string",
                        "description": (
                            "Additional raw katana flags, e.g. '-form-extraction' or '-known-files all'. "
                            "Do NOT include -u, -d, -proxy, -js-crawl, -headless (use dedicated params)."
                        ),
                    },
                },
                "required": ["url"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # ffuf parameter/credential/SQLi fuzzer (NOT for directory discovery)
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "run_ffuf",
            "description": (
                "Run ffuf (Fuzz Faster U Fool) inside the ferret-lab sandbox for parameter fuzzing, "
                "credential brute-forcing, vhost discovery, or SQLi fuzzing. "
                "NOT intended for directory/file discovery — use run_katana for that instead. "
                "Place the FUZZ keyword anywhere in the URL, headers, or POST data. "
                "Returns a summary of matches with status codes, sizes, and response times. "
                "Available wordlists inside the sandbox:\n"
                "  /usr/share/dirb/wordlists/common.txt  (default, ~4600 entries, fast)\n"
                "  /usr/share/dirb/wordlists/big.txt  (~20000 entries)\n"
                "  /usr/share/seclists/Discovery/Web-Content/common.txt\n"
                "  /usr/share/seclists/Discovery/Web-Content/directory-list-2.3-medium.txt\n"
                "  /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt\n"
                "  /usr/share/seclists/Discovery/Web-Content/raft-large-files.txt\n"
                "  /usr/share/seclists/Discovery/Web-Content/api/api-endpoints.txt\n"
                "  /usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt\n"
                "  /usr/share/seclists/Usernames/top-usernames-shortlist.txt\n"
                "  /usr/share/seclists/Passwords/Common-Credentials/10-million-password-list-top-10000.txt\n"
                "  /usr/share/seclists/Fuzzing/SQLi/Generic-SQLi.txt\n"
                "Results are truncated to 16 KB."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": (
                            "Target URL with FUZZ placeholder, e.g. "
                            "'https://example.com/FUZZ' or 'https://example.com/api/FUZZ.php'."
                        ),
                    },
                    "wordlist": {
                        "type": "string",
                        "description": (
                            "Absolute path to wordlist inside the sandbox. "
                            "Defaults to /usr/share/dirb/wordlists/common.txt."
                        ),
                    },
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                        "description": "HTTP method (default GET).",
                    },
                    "headers": {
                        "type": "object",
                        "description": "Extra request headers as key-value pairs.",
                    },
                    "data": {
                        "type": "string",
                        "description": "POST body data (use FUZZ as placeholder for fuzzing).",
                    },
                    "match_codes": {
                        "type": "string",
                        "description": (
                            "Comma-separated HTTP status codes to match, e.g. '200,301,302,403'. "
                            "Defaults to '200,204,301,302,307,401,403,405,500'."
                        ),
                    },
                    "filter_codes": {
                        "type": "string",
                        "description": "Comma-separated HTTP status codes to filter out (hide from results).",
                    },
                    "filter_size": {
                        "type": "string",
                        "description": "Filter responses by size, e.g. '0' to hide empty responses.",
                    },
                    "threads": {
                        "type": "integer",
                        "description": "Number of concurrent threads (default 40, max 100).",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Total execution timeout in seconds (default 60, max 300).",
                    },
                    "extra_args": {
                        "type": "string",
                        "description": (
                            "Additional raw ffuf flags, e.g. '-recursion -recursion-depth 2' "
                            "or '-H \"Host: FUZZ.example.com\"' for vhost fuzzing. "
                            "Do NOT include -u, -w, -X, -d, -H (use the dedicated params instead)."
                        ),
                    },
                },
                "required": ["url"],
            },
        },
    },
    # -----------------------------------------------------------------------
    # Direct HTTP request tool
    # -----------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "http_request",
            "description": (
                "Send a single HTTP request directly and return the status code, "
                "response headers, and response body. Use this for quick interactive "
                "probing of endpoints — e.g. to test a payload or confirm a vulnerability — "
                "without writing a full pytest file. "
                "Requests are routed through the FERRET proxy (port 1337) by default so they "
                "appear in the request history. "
                "Use write_pytest_file only once you have a confirmed finding to codify."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
                        "description": "HTTP method.",
                    },
                    "url": {
                        "type": "string",
                        "description": "Full URL including scheme, e.g. https://example.com/api/login",
                    },
                    "headers": {
                        "type": "object",
                        "description": "Optional request headers as key-value pairs.",
                    },
                    "body": {
                        "type": "string",
                        "description": "Optional request body (raw string).",
                    },
                    "content_type": {
                        "type": "string",
                        "description": (
                            "Content-Type header value, e.g. 'application/json', "
                            "'application/x-www-form-urlencoded', or 'application/xml'."
                        ),
                    },
                    "via_proxy": {
                        "type": "boolean",
                        "description": (
                            "If true (default), route through FERRET proxy on 127.0.0.1:1337 "
                            "so the request appears in history."
                        ),
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Request timeout in seconds (default 15).",
                    },
                },
                "required": ["method", "url"],
            },
        },
    },
]

# ---------------------------------------------------------------------------
# Inject a required `rationale` field into every tool so the model always
# explains why it is calling the tool. This appears in the UI as a sub-panel.
# ---------------------------------------------------------------------------

_RATIONALE_PROP = {
    "type": "string",
    "description": "One sentence explaining why you are calling this tool right now.",
}
for _t in SESSION_CHAT_TOOLS:
    _props = _t["function"]["parameters"]["properties"]
    _props["rationale"] = _RATIONALE_PROP
    _req: list = _t["function"]["parameters"].setdefault("required", [])
    if "rationale" not in _req:
        _req.insert(0, "rationale")
