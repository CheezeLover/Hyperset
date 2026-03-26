import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getAllPageSettings, setPageSettings, deletePageSettings, type PageSettings } from "@/lib/page-settings";
import fs from "fs";
import path from "path";

const PAGES_DIR = process.env.PAGES_DIR ?? path.join(process.cwd(), "pages");

import { checkRateLimit } from "@/lib/utils";

const _rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 20;
const RATE_WINDOW = 60_000;

function requireAdmin(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

function requireAuth(request: NextRequest) {
  const user = getUserFromRequest(request);
  if (!user.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

function scanPagesDir(): { name: string; hasBackend: boolean }[] {
  const pages: { name: string; hasBackend: boolean }[] = [];
  try {
    if (!fs.existsSync(PAGES_DIR)) return pages;
    const entries = fs.readdirSync(PAGES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const indexPath = path.join(PAGES_DIR, entry.name, "index.html");
        const backendPath = path.join(PAGES_DIR, entry.name, "backend.py");
        if (fs.existsSync(indexPath)) {
          pages.push({
            name: entry.name,
            hasBackend: fs.existsSync(backendPath),
          });
        }
      }
    }
  } catch (e) {
    console.error("[admin/pages] Failed to scan pages directory:", e);
  }
  return pages.sort((a, b) => a.name.localeCompare(b.name));
}

/** GET /api/admin/pages — list all pages with their metadata (any authenticated user) */
export async function GET(request: NextRequest) {
  const denied = requireAuth(request);
  if (denied) return denied;

  const { email } = getUserFromRequest(request);
  if (!checkRateLimit(_rateLimitMap, RATE_LIMIT, RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const pages = scanPagesDir();
  const settings = await getAllPageSettings();

  const pagesWithMeta = pages.map((p) => ({
    name: p.name,
    hasBackend: p.hasBackend,
    active: settings[p.name]?.active ?? true,
    allowedGroups: settings[p.name]?.allowedGroups ?? [],
    icon: settings[p.name]?.icon,
    iconColor: settings[p.name]?.iconColor,
  }));

  return NextResponse.json({ pages: pagesWithMeta });
}

/** POST /api/admin/pages — upload a new page */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { email } = getUserFromRequest(request);
  if (!checkRateLimit(_rateLimitMap, RATE_LIMIT, RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Content-Type must be multipart/form-data" }, { status: 400 });
  }

  try {
    const formData = await request.formData();
    const name = formData.get("name")?.toString().trim();
    const htmlFile = formData.get("html") as File | null;
    const backendFile = formData.get("backend") as File | null;

    if (!name) {
      return NextResponse.json({ error: "Page name is required" }, { status: 400 });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return NextResponse.json({ error: "Page name must contain only letters, numbers, underscores and hyphens" }, { status: 400 });
    }

    if (!htmlFile) {
      return NextResponse.json({ error: "HTML file is required" }, { status: 400 });
    }

    const pageDir = path.join(PAGES_DIR, name);
    
    if (fs.existsSync(pageDir)) {
      return NextResponse.json({ error: `Page "${name}" already exists` }, { status: 400 });
    }

    fs.mkdirSync(pageDir, { recursive: true });

    const htmlBuffer = Buffer.from(await htmlFile.arrayBuffer());
    fs.writeFileSync(path.join(pageDir, "index.html"), htmlBuffer);

    if (backendFile && backendFile.size > 0) {
      const backendBuffer = Buffer.from(await backendFile.arrayBuffer());
      fs.writeFileSync(path.join(pageDir, "backend.py"), backendBuffer);
    }

    await setPageSettings(name, { active: true, allowedGroups: [] });

    return NextResponse.json({
      ok: true,
      page: {
        name, 
        hasBackend: !!backendFile && backendFile.size > 0,
        active: true,
        allowedGroups: [],
      } 
    });
  } catch (e) {
    console.error("[admin/pages] Failed to upload page:", e);
    return NextResponse.json({ error: "Failed to upload page" }, { status: 500 });
  }
}

/** PUT /api/admin/pages — update page files */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { email } = getUserFromRequest(request);
  if (!checkRateLimit(_rateLimitMap, RATE_LIMIT, RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Content-Type must be multipart/form-data" }, { status: 400 });
  }

  try {
    const formData = await request.formData();
    const name = formData.get("name")?.toString().trim();
    const htmlFile = formData.get("html") as File | null;
    const backendFile = formData.get("backend") as File | null;

    if (!name) {
      return NextResponse.json({ error: "Page name is required" }, { status: 400 });
    }

    const pageDir = path.join(PAGES_DIR, name);
    if (!fs.existsSync(path.join(pageDir, "index.html"))) {
      return NextResponse.json({ error: `Page "${name}" not found` }, { status: 404 });
    }

    if (htmlFile && htmlFile.size > 0) {
      const htmlBuffer = Buffer.from(await htmlFile.arrayBuffer());
      fs.writeFileSync(path.join(pageDir, "index.html"), htmlBuffer);
    }

    if (backendFile && backendFile.size > 0) {
      const backendBuffer = Buffer.from(await backendFile.arrayBuffer());
      fs.writeFileSync(path.join(pageDir, "backend.py"), backendBuffer);
    } else if (formData.get("removeBackend") === "true") {
      const backendPath = path.join(pageDir, "backend.py");
      if (fs.existsSync(backendPath)) {
        fs.unlinkSync(backendPath);
      }
    }

    const hasBackend = fs.existsSync(path.join(pageDir, "backend.py"));

    return NextResponse.json({ ok: true, hasBackend });
  } catch (e) {
    console.error("[admin/pages] Failed to update page files:", e);
    return NextResponse.json({ error: "Failed to update page files" }, { status: 500 });
  }
}

/** PATCH /api/admin/pages — update page settings */
export async function PATCH(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { email } = getUserFromRequest(request);
  if (!checkRateLimit(_rateLimitMap, RATE_LIMIT, RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const { name, active, allowedGroups, icon, iconColor } = body as { 
      name: string; 
      active?: boolean; 
      allowedGroups?: string[];
      icon?: string;
      iconColor?: string;
    };

    if (!name) {
      return NextResponse.json({ error: "Page name is required" }, { status: 400 });
    }

    const pageDir = path.join(PAGES_DIR, name);
    if (!fs.existsSync(path.join(pageDir, "index.html"))) {
      return NextResponse.json({ error: `Page "${name}" not found` }, { status: 404 });
    }

    const current = (await getAllPageSettings())[name] ?? { active: true, allowedGroups: [] };
    const updated: PageSettings = {
      active: active !== undefined ? active : current.active,
      allowedGroups: allowedGroups !== undefined ? allowedGroups : current.allowedGroups,
      icon: icon !== undefined ? icon : current.icon,
      iconColor: iconColor !== undefined ? iconColor : current.iconColor,
    };

    await setPageSettings(name, updated);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[admin/pages] Failed to update page:", e);
    return NextResponse.json({ error: "Failed to update page" }, { status: 500 });
  }
}

/** DELETE /api/admin/pages — delete a page */
export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { email } = getUserFromRequest(request);
  if (!checkRateLimit(_rateLimitMap, RATE_LIMIT, RATE_WINDOW, email)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const { name } = body as { name: string };

    if (!name) {
      return NextResponse.json({ error: "Page name is required" }, { status: 400 });
    }

    const pageDir = path.join(PAGES_DIR, name);
    if (!fs.existsSync(path.join(pageDir, "index.html"))) {
      return NextResponse.json({ error: `Page "${name}" not found` }, { status: 404 });
    }

    fs.rmSync(pageDir, { recursive: true, force: true });
    await deletePageSettings(name);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[admin/pages] Failed to delete page:", e);
    return NextResponse.json({ error: "Failed to delete page" }, { status: 500 });
  }
}