import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export interface NetworkResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}
export type FederationNetwork = (request: Request, maxBytes?: number) => Promise<NetworkResponse>;
export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** No environment flag can relax this policy. Test transports are injected by tests. */
export function validateRemoteURL(input: string): URL {
  const u = new URL(input);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== '443') ||
    u.hostname.endsWith('.') ||
    u.hostname.length > 253 ||
    input.length > 2048
  )
    throw new Error('Unsafe remote address');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (!isIP(host) && !host.includes('.'))
  )
    throw new Error('Unsafe remote address');
  if (isIP(host) && !publicAddress(host)) throw new Error('Unsafe remote address');
  return u;
}

export function publicAddress(address: string): boolean {
  try {
    const a = ipaddr.process(address);
    // Includes IPv4-mapped IPv6 handling; excludes loopback, private, multicast,
    // CGNAT, link-local, documentation, reserved and transition mechanisms.
    if (a.range() !== 'unicast') return false;
    if (a.kind() === 'ipv6') {
      const bytes = a.toByteArray();
      return (bytes[0]! & 0xe0) === 0x20; // only global 2000::/3
    }
    return true;
  } catch {
    return false;
  }
}

/** Resolve once, reject mixed public/private answers, and pin the socket to that
 * checked address. TLS still authenticates the original hostname. No redirects,
 * cookies, proxies, compressed responses, or off-origin context loading. */
export const safeFederationNetwork: FederationNetwork = async (
  req,
  maxBytes = MAX_DOCUMENT_BYTES,
) => {
  const url = validateRemoteURL(req.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const answers = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('DNS timeout')), 5_000);
          t.unref();
        }),
      ]);
  if (!answers.length || answers.some((a) => !publicAddress(a.address)))
    throw new Error('Unsafe DNS answer');
  const chosen = answers[0]!;
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
  if (body && body.length > MAX_DOCUMENT_BYTES) throw new Error('Outgoing document too large');
  const headers = Object.fromEntries(req.headers);
  headers['accept-encoding'] = 'identity';
  if (body) headers['content-length'] = String(body.length);
  return new Promise<NetworkResponse>((resolve, reject) => {
    const outgoing = httpsRequest(
      url,
      {
        method: req.method,
        headers,
        agent: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        servername: isIP(host) ? undefined : host,
        // Passed through to net.connect; HTTPS RequestOptions omits this net option.
        ...{ autoSelectFamily: true },
        lookup: ((
          _host: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (options.all) callback(null, answers);
          else callback(null, chosen.address, chosen.family);
        }) as never,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          reject(new Error('Redirects are prohibited'));
          return;
        }
        if (
          incoming.headers['content-encoding'] &&
          incoming.headers['content-encoding'] !== 'identity'
        ) {
          incoming.destroy();
          reject(new Error('Compressed federation responses are prohibited'));
          return;
        }
        if (Number(incoming.headers['content-length'] ?? 0) > maxBytes) {
          incoming.destroy();
          reject(new Error('Response too large'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            incoming.destroy();
            reject(new Error('Response too large'));
          } else chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined)
              responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks) });
        });
      },
    );
    const deadline = setTimeout(() => outgoing.destroy(new Error('Federation timeout')), 10_000);
    deadline.unref();
    outgoing.on('close', () => clearTimeout(deadline));
    outgoing.on('error', reject);
    if (req.signal.aborted) outgoing.destroy(new Error('Request aborted'));
    req.signal.addEventListener('abort', () => outgoing.destroy(new Error('Request aborted')), {
      once: true,
    });
    outgoing.end(body);
  });
};
