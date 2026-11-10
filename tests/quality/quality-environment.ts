/** One local origin for the runner, Vite and all quality-test network fixtures. */
export function parseQualityPort(value: string | undefined): number {
  if (value === undefined) return 4176;
  const text = value.trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('PURAMA_QUALITY_PORT must be an integer between 1024 and 65535');
  }
  return port;
}

export const qualityHost = '127.0.0.1';
export const qualityPort = parseQualityPort(process.env.PURAMA_QUALITY_PORT);
export const qualityOrigin = `http://${qualityHost}:${qualityPort}`;
