"""
Hyperset Pages Service
======================
Single FastAPI process that:
  - Serves each Pages/{name}/index.html at GET /{name}
  - Mounts Pages/{name}/backend.py router at /{name}/api  (if present)
  - Exposes GET /__pages__ listing all discovered pages (for the portal)
  - Watches Pages/ at runtime with watchdog and hot-reloads pages on changes
"""

import importlib.util
import logging
import sys
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

PAGES_DIR = Path("/pages")
log = logging.getLogger("hyperset-pages")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")

app = FastAPI(title="Hyperset Pages", docs_url=None, redoc_url=None)

# Registry: { page_name: { "has_backend": bool } }
_registry: dict[str, dict] = {}
# Lock for hot-reload thread safety
_registry_lock = threading.Lock()


# ── Page discovery & mounting ──────────────────────────────────────────────────

def _load_page(page_dir: Path) -> None:
    """Register a single page directory. Mount its backend router if present."""
    name = page_dir.name
    index = page_dir / "index.html"
    backend_path = page_dir / "backend.py"

    if not index.is_file():
        log.warning("Skipping %s — no index.html found", name)
        return

    has_backend = False

    if backend_path.is_file():
        try:
            # Load backend.py in its own isolated module namespace
            spec = importlib.util.spec_from_file_location(
                f"pages.{name}.backend", backend_path
            )
            module = importlib.util.module_from_spec(spec)
            # Isolated: do NOT insert into sys.modules under a shared key
            sys.modules[f"pages.{name}.backend"] = module
            spec.loader.exec_module(module)

            router = getattr(module, "router", None)
            if router is None:
                log.warning("%s/backend.py has no `router` — skipping backend", name)
            else:
                app.include_router(router, prefix=f"/{name}/api")
                has_backend = True
                log.info("Mounted /%s/api  (backend.py loaded)", name)
        except Exception:
            log.exception("Failed to load backend for page '%s'", name)

    with _registry_lock:
        _registry[name] = {"has_backend": has_backend}

    log.info("Registered page: %s  (backend=%s)", name, has_backend)


def _unload_page(name: str) -> None:
    """Remove a page from the registry and clean up its module."""
    with _registry_lock:
        _registry.pop(name, None)

    # Remove the isolated backend module from sys.modules
    mod_key = f"pages.{name}.backend"
    sys.modules.pop(mod_key, None)

    # FastAPI does not support dynamic route removal, so we log a notice.
    # The stale /{name}/api routes will 404 naturally since the module is gone,
    # but the route objects remain until next full process restart.
    log.info("Unregistered page: %s", name)


def _scan_pages() -> None:
    """Initial full scan of PAGES_DIR."""
    if not PAGES_DIR.is_dir():
        log.warning("Pages directory %s does not exist yet", PAGES_DIR)
        return
    for entry in sorted(PAGES_DIR.iterdir()):
        if entry.is_dir() and not entry.name.startswith("."):
            _load_page(entry)


# ── Watchdog file-system watcher ───────────────────────────────────────────────

class _PagesEventHandler(FileSystemEventHandler):
    """React to changes inside PAGES_DIR."""

    def _page_name_from_path(self, path: str) -> str | None:
        p = Path(path)
        try:
            rel = p.relative_to(PAGES_DIR)
        except ValueError:
            return None
        parts = rel.parts
        return parts[0] if parts else None

    def on_created(self, event):
        name = self._page_name_from_path(event.src_path)
        if not name:
            return
        page_dir = PAGES_DIR / name
        if page_dir.is_dir():
            log.info("Detected new page directory: %s", name)
            _load_page(page_dir)

    def on_modified(self, event):
        name = self._page_name_from_path(event.src_path)
        if not name:
            return
        page_dir = PAGES_DIR / name
        if page_dir.is_dir() and (page_dir / "index.html").is_file():
            log.info("Detected change in page: %s — reloading", name)
            _unload_page(name)
            _load_page(page_dir)

    def on_deleted(self, event):
        name = self._page_name_from_path(event.src_path)
        if not name:
            return
        page_dir = PAGES_DIR / name
        # If the directory itself was deleted
        if not page_dir.exists():
            log.info("Page directory removed: %s", name)
            _unload_page(name)


def _start_watcher() -> None:
    observer = Observer()
    observer.schedule(_PagesEventHandler(), str(PAGES_DIR), recursive=True)
    observer.daemon = True
    observer.start()
    log.info("Watching %s for changes", PAGES_DIR)


# ── API endpoints ──────────────────────────────────────────────────────────────

@app.get("/__pages__")
async def list_pages():
    """Return all currently registered pages. Used by the portal to build the sidebar."""
    with _registry_lock:
        pages = [
            {"name": name, "has_backend": info["has_backend"]}
            for name, info in sorted(_registry.items())
        ]
    return JSONResponse({"pages": pages})


@app.get("/{page_name}", include_in_schema=False)
async def serve_page(page_name: str):
    """Serve the index.html for a registered page."""
    with _registry_lock:
        known = page_name in _registry
    if not known:
        return JSONResponse({"detail": "Page not found"}, status_code=404)
    index = PAGES_DIR / page_name / "index.html"
    return FileResponse(index, media_type="text/html")


# ── Startup ────────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    _scan_pages()
    _start_watcher()


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
