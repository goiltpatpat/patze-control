const DEFAULT_HTTP_PORT = '80';
const DEFAULT_HTTPS_PORT = '443';

function toDefaultPort(protocol: string): string {
  return protocol === 'https:' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
}

export function normalizeEndpoint(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    const normalized = new URL(parsed.toString());
    normalized.pathname = '';
    normalized.search = '';
    normalized.hash = '';
    return normalized.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function getWindowHostCandidates(): readonly string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  const host = window.location.hostname.trim();
  if (host.length === 0 || host === '0.0.0.0') {
    return [];
  }

  if (host === 'localhost') {
    return [host, '127.0.0.1'];
  }
  if (host === '127.0.0.1') {
    return [host, 'localhost'];
  }
  return [host];
}

function addCandidate(candidates: Set<string>, protocol: string, host: string, port: string): void {
  if (host.length === 0 || port.length === 0) {
    return;
  }

  const url = new URL(`${protocol}//${host}`);
  url.port = port;

  const normalized = normalizeEndpoint(url.toString());
  if (normalized) {
    candidates.add(normalized);
  }
}

export function buildEndpointFallbackCandidates(baseUrl: string, preferredPort = '9700'): string[] {
  const normalizedBaseUrl = normalizeEndpoint(baseUrl);
  if (!normalizedBaseUrl) {
    return [];
  }

  const current = new URL(normalizedBaseUrl);
  const protocol = current.protocol === 'https:' ? 'https:' : 'http:';
  const currentPort = current.port.length > 0 ? current.port : toDefaultPort(protocol);

  const portCandidates = new Set<string>([currentPort]);
  if (preferredPort.length > 0) {
    portCandidates.add(preferredPort);
  }

  const hostCandidates = new Set<string>([current.hostname]);
  if (current.hostname === '127.0.0.1') {
    hostCandidates.add('localhost');
  } else if (current.hostname === 'localhost') {
    hostCandidates.add('127.0.0.1');
  }

  for (const host of getWindowHostCandidates()) {
    hostCandidates.add(host);
  }

  const candidates = new Set<string>();
  for (const host of hostCandidates) {
    for (const port of portCandidates) {
      addCandidate(candidates, protocol, host, port);
    }
  }

  return Array.from(candidates);
}
