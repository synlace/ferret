"""
test_shim.py — Unit tests for the Ferret docker-exec shim allow/block logic.

Tests the _is_allowed() function exhaustively:
  - All permitted patterns (with and without /v1.NN version prefix)
  - The critical blocked patterns (POST /containers/create, GET /containers/json, etc.)
  - docker cp archive endpoint (PUT/GET/HEAD /containers/ferret-lab/archive)
  - Edge cases: wrong method, wrong container name, partial path matches

Run with:
    cd github/ferret/src/apps/docker-shim
    python -m pytest test_shim.py -v
  or simply:
    python -m unittest test_shim -v

No Docker socket or network access required — pure logic tests.
"""

import importlib
import os
import sys
import unittest

# ---------------------------------------------------------------------------
# Import shim with a known ALLOWED_CONTAINER so tests are deterministic
# regardless of the host environment variable.
# ---------------------------------------------------------------------------
os.environ.setdefault("ALLOWED_CONTAINER", "ferret-lab")

# Add the shim directory to sys.path so we can import shim.py directly.
_SHIM_DIR = os.path.dirname(__file__)
if _SHIM_DIR not in sys.path:
    sys.path.insert(0, _SHIM_DIR)

import shim  # noqa: E402  (import after path manipulation)

# Reload to pick up the env var set above (in case shim was already imported).
importlib.reload(shim)

_is_allowed = shim._is_allowed

# A realistic exec ID (64-char hex, as Docker produces)
EXEC_ID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
# Short hex IDs are also valid (Docker CLI uses 12-char abbreviations)
EXEC_ID_SHORT = "a1b2c3d4e5f6"


class TestAllowedPatterns(unittest.TestCase):
    """All permitted operations must be allowed, with and without version prefix."""

    # ── ping (Docker CLI version negotiation before every command) ────────────

    def test_ping_get_bare(self):
        self.assertTrue(_is_allowed("GET", "/_ping"))

    def test_ping_head_bare(self):
        self.assertTrue(_is_allowed("HEAD", "/_ping"))

    def test_ping_get_versioned(self):
        self.assertTrue(_is_allowed("GET", "/v1.41/_ping"))

    def test_ping_head_versioned(self):
        self.assertTrue(_is_allowed("HEAD", "/v1.41/_ping"))

    # ── container-inspect (Docker CLI resolves name→ID before exec-create) ───

    def test_container_inspect_bare(self):
        self.assertTrue(_is_allowed("GET", "/containers/ferret-lab/json"))

    def test_container_inspect_versioned(self):
        self.assertTrue(_is_allowed("GET", "/v1.41/containers/ferret-lab/json"))

    # ── exec-create ──────────────────────────────────────────────────────────

    def test_exec_create_bare(self):
        self.assertTrue(_is_allowed("POST", "/containers/ferret-lab/exec"))

    def test_exec_create_versioned(self):
        self.assertTrue(_is_allowed("POST", "/v1.41/containers/ferret-lab/exec"))

    def test_exec_create_versioned_high(self):
        self.assertTrue(_is_allowed("POST", "/v1.47/containers/ferret-lab/exec"))

    # ── exec-start ───────────────────────────────────────────────────────────

    def test_exec_start_bare(self):
        self.assertTrue(_is_allowed("POST", f"/exec/{EXEC_ID}/start"))

    def test_exec_start_versioned(self):
        self.assertTrue(_is_allowed("POST", f"/v1.41/exec/{EXEC_ID}/start"))

    def test_exec_start_short_id(self):
        self.assertTrue(_is_allowed("POST", f"/exec/{EXEC_ID_SHORT}/start"))

    # ── exec-resize ──────────────────────────────────────────────────────────

    def test_exec_resize_bare(self):
        self.assertTrue(_is_allowed("POST", f"/exec/{EXEC_ID}/resize"))

    def test_exec_resize_versioned(self):
        self.assertTrue(_is_allowed("POST", f"/v1.41/exec/{EXEC_ID}/resize"))

    def test_exec_resize_short_id(self):
        self.assertTrue(_is_allowed("POST", f"/exec/{EXEC_ID_SHORT}/resize"))

    # ── exec-inspect ─────────────────────────────────────────────────────────

    def test_exec_inspect_bare(self):
        self.assertTrue(_is_allowed("GET", f"/exec/{EXEC_ID}/json"))

    def test_exec_inspect_versioned(self):
        self.assertTrue(_is_allowed("GET", f"/v1.41/exec/{EXEC_ID}/json"))

    def test_exec_inspect_short_id(self):
        self.assertTrue(_is_allowed("GET", f"/exec/{EXEC_ID_SHORT}/json"))

    # ── docker-cp archive (PUT/GET/HEAD /containers/ferret-lab/archive) ──────

    def test_archive_put_bare(self):
        """PUT /containers/ferret-lab/archive — docker cp host→container."""
        self.assertTrue(_is_allowed("PUT", "/containers/ferret-lab/archive"))

    def test_archive_put_versioned(self):
        self.assertTrue(_is_allowed("PUT", "/v1.41/containers/ferret-lab/archive"))

    def test_archive_get_bare(self):
        """GET /containers/ferret-lab/archive — docker cp container→host."""
        self.assertTrue(_is_allowed("GET", "/containers/ferret-lab/archive"))

    def test_archive_get_versioned(self):
        self.assertTrue(_is_allowed("GET", "/v1.41/containers/ferret-lab/archive"))

    def test_archive_head_bare(self):
        """HEAD /containers/ferret-lab/archive — docker cp stat path."""
        self.assertTrue(_is_allowed("HEAD", "/containers/ferret-lab/archive"))

    def test_archive_head_versioned(self):
        self.assertTrue(_is_allowed("HEAD", "/v1.41/containers/ferret-lab/archive"))

    def test_archive_put_with_query_string(self):
        """Query strings (e.g. ?path=/tmp) must not break archive matching."""
        self.assertTrue(_is_allowed("PUT", "/containers/ferret-lab/archive?path=%2Ftmp"))

    def test_archive_get_with_query_string(self):
        self.assertTrue(_is_allowed("GET", "/containers/ferret-lab/archive?path=%2Ftmp"))

    # ── query strings must not break matching ─────────────────────────────────

    def test_exec_create_with_query_string(self):
        self.assertTrue(_is_allowed("POST", "/containers/ferret-lab/exec?foo=bar"))

    def test_exec_start_with_query_string(self):
        self.assertTrue(_is_allowed("POST", f"/exec/{EXEC_ID}/start?foo=bar"))


class TestBlockedPatterns(unittest.TestCase):
    """Critical blocked operations must return False."""

    # ── The RCE vector ────────────────────────────────────────────────────────

    def test_block_containers_create(self):
        """POST /containers/create is the exploit vector — must be blocked."""
        self.assertFalse(_is_allowed("POST", "/containers/create"))

    def test_block_containers_create_versioned(self):
        self.assertFalse(_is_allowed("POST", "/v1.41/containers/create"))

    # ── Container listing / inspection ───────────────────────────────────────

    def test_block_containers_json(self):
        self.assertFalse(_is_allowed("GET", "/containers/json"))

    def test_block_containers_json_versioned(self):
        self.assertFalse(_is_allowed("GET", "/v1.41/containers/json"))

    def test_block_container_inspect_wrong_container(self):
        """Inspecting any container other than ferret-lab must be blocked."""
        self.assertFalse(_is_allowed("GET", "/containers/evil-container/json"))

    def test_block_container_inspect_listing(self):
        """GET /containers/json (list all containers) must still be blocked."""
        self.assertFalse(_is_allowed("GET", "/containers/json"))

    # ── Image operations ──────────────────────────────────────────────────────

    def test_block_images_json(self):
        self.assertFalse(_is_allowed("GET", "/images/json"))

    def test_block_image_pull(self):
        self.assertFalse(_is_allowed("POST", "/images/create"))

    # ── Volume / network operations ───────────────────────────────────────────

    def test_block_volumes(self):
        self.assertFalse(_is_allowed("GET", "/volumes"))

    def test_block_networks(self):
        self.assertFalse(_is_allowed("GET", "/networks"))

    # ── System / info ─────────────────────────────────────────────────────────

    def test_block_info(self):
        self.assertFalse(_is_allowed("GET", "/info"))

    def test_block_ping_post(self):
        """POST /_ping is not a valid Docker operation — must be blocked."""
        self.assertFalse(_is_allowed("POST", "/_ping"))

    def test_block_version(self):
        self.assertFalse(_is_allowed("GET", "/version"))

    def test_block_system_info(self):
        self.assertFalse(_is_allowed("GET", "/info"))

    # ── Container start/stop/kill ─────────────────────────────────────────────

    def test_block_container_start(self):
        self.assertFalse(_is_allowed("POST", "/containers/ferret-lab/start"))

    def test_block_container_stop(self):
        self.assertFalse(_is_allowed("POST", "/containers/ferret-lab/stop"))

    def test_block_container_kill(self):
        self.assertFalse(_is_allowed("POST", "/containers/ferret-lab/kill"))

    def test_block_container_remove(self):
        self.assertFalse(_is_allowed("DELETE", "/containers/ferret-lab"))

    # ── Archive (docker cp) on a DIFFERENT container ──────────────────────────

    def test_block_archive_put_wrong_container(self):
        """PUT /containers/evil/archive must be blocked — wrong container."""
        self.assertFalse(_is_allowed("PUT", "/containers/evil-container/archive"))

    def test_block_archive_get_wrong_container(self):
        self.assertFalse(_is_allowed("GET", "/containers/attacker/archive"))

    def test_block_archive_head_wrong_container(self):
        self.assertFalse(_is_allowed("HEAD", "/containers/attacker/archive"))

    def test_block_archive_post_ferret_lab(self):
        """POST /containers/ferret-lab/archive is not a valid Docker operation."""
        self.assertFalse(_is_allowed("POST", "/containers/ferret-lab/archive"))

    def test_block_archive_delete_ferret_lab(self):
        self.assertFalse(_is_allowed("DELETE", "/containers/ferret-lab/archive"))

    def test_block_archive_wrong_container_versioned(self):
        self.assertFalse(_is_allowed("PUT", "/v1.41/containers/evil/archive"))

    # ── Exec operations on a DIFFERENT container ──────────────────────────────

    def test_block_exec_create_wrong_container(self):
        """exec-create on any container other than ferret-lab must be blocked."""
        self.assertFalse(_is_allowed("POST", "/containers/evil-container/exec"))

    def test_block_exec_create_wrong_container_versioned(self):
        self.assertFalse(_is_allowed("POST", "/v1.41/containers/attacker/exec"))

    # ── Wrong HTTP method for allowed paths ───────────────────────────────────

    def test_block_get_exec_create(self):
        """GET on exec-create path must be blocked (only POST is allowed)."""
        self.assertFalse(_is_allowed("GET", "/containers/ferret-lab/exec"))

    def test_block_get_exec_start(self):
        self.assertFalse(_is_allowed("GET", f"/exec/{EXEC_ID}/start"))

    def test_block_post_exec_inspect(self):
        """POST on exec-inspect path must be blocked (only GET is allowed)."""
        self.assertFalse(_is_allowed("POST", f"/exec/{EXEC_ID}/json"))

    def test_block_delete_exec(self):
        self.assertFalse(_is_allowed("DELETE", f"/exec/{EXEC_ID}/start"))

    # ── Path traversal / injection attempts ──────────────────────────────────

    def test_block_path_traversal_container_name(self):
        self.assertFalse(_is_allowed("POST", "/containers/ferret-lab/../evil/exec"))

    def test_block_prefix_match_only(self):
        """ferret-lab-extra must not match the ferret-lab allow rule."""
        self.assertFalse(_is_allowed("POST", "/containers/ferret-lab-extra/exec"))

    def test_block_suffix_match_only(self):
        """prefix-ferret-lab must not match the ferret-lab allow rule."""
        self.assertFalse(_is_allowed("POST", "/containers/prefix-ferret-lab/exec"))

    # ── Non-hex exec IDs must not match ──────────────────────────────────────

    def test_block_exec_start_non_hex_id(self):
        """Exec IDs must be hex — a non-hex ID should not match."""
        self.assertFalse(_is_allowed("POST", "/exec/not-a-hex-id!/start"))

    def test_block_exec_inspect_non_hex_id(self):
        self.assertFalse(_is_allowed("GET", "/exec/../../etc/passwd/json"))


class TestVersionPrefixStripping(unittest.TestCase):
    """Version prefix stripping must work for a range of version numbers."""

    def test_v1_24(self):
        self.assertTrue(_is_allowed("POST", "/v1.24/containers/ferret-lab/exec"))

    def test_v1_99(self):
        self.assertTrue(_is_allowed("POST", "/v1.99/containers/ferret-lab/exec"))

    def test_double_version_prefix_blocked(self):
        """A double version prefix is not a valid Docker path — must be blocked."""
        self.assertFalse(_is_allowed("POST", "/v1.41/v1.41/containers/ferret-lab/exec"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
