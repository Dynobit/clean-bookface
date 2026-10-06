#!/usr/bin/env node
/** Read only reviewed production pins; never execute a host module to discover images. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export function pinnedHostImages(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const pins = JSON.parse(readFileSync(resolve(root, 'encrypted-host/images.json'), 'utf8'));
  if (JSON.stringify(Object.keys(pins).sort()) !== JSON.stringify(['postgres', 'synapse']))
    throw new Error('Unexpected production image lock inventory');
  for (const [component, file, variable] of [
    ['caddy', 'operations.py', 'CADDY'],
    ['restic', 'recovery.py', 'RESTIC'],
  ]) {
    const text = readFileSync(resolve(root, 'encrypted-host', file), 'utf8');
    const matches = [
      ...text.matchAll(new RegExp(`^${variable}\\s*=\\s*(['"])([^'"\\r\\n]+)\\1\\s*$`, 'gm')),
    ];
    if (matches.length !== 1) throw new Error(`Missing or ambiguous ${component} image pin`);
    pins[component] = matches[0][2];
  }
  return Object.entries(pins)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([component, image]) => {
      if (
        typeof image !== 'string' ||
        !/^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9_.-]+@sha256:[a-f0-9]{64}$/.test(image)
      )
        throw new Error(`Invalid immutable ${component} image pin`);
      return { component, image };
    });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify({ include: pinnedHostImages() }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
