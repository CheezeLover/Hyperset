const DEFAULT_HYPERSET_DOMAIN = "hyperset.internal";

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function normalizeUrl(url: string, defaultProtocol: "http" | "https" = "https"): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `${defaultProtocol}://${trimmed}`;
}

export function getHypersetDomain(): string {
  return readEnv("HYPERSET_DOMAIN") ?? DEFAULT_HYPERSET_DOMAIN;
}

function getDerivedSubdomainUrl(envName: string, subdomain: string): string {
  const explicit = readEnv(envName);
  if (explicit) {
    return normalizeUrl(explicit);
  }
  return `https://${subdomain}.${getHypersetDomain()}`;
}

export function getSupersetPublicUrl(): string {
  return getDerivedSubdomainUrl("SUPERSET_PUBLIC_URL", "superset");
}

export function getPagesPublicUrl(): string {
  return getDerivedSubdomainUrl("PAGES_PUBLIC_URL", "pages");
}
