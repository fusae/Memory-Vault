const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function assertDashboardHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error('Dashboard only supports loopback binding; use an authenticated reverse proxy for remote access');
  }
}
