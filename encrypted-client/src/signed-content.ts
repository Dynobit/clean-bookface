import type { MatrixClient } from 'matrix-js-sdk';
import {
  initAsync,
  UserId,
  type OlmMachine,
  type OtherUserIdentity,
  type OwnUserIdentity,
} from '@matrix-org/matrix-sdk-crypto-wasm';
// The pinned SDK uses this exact package for Matrix canonical signed JSON.
// @ts-expect-error another-json 0.2.0 has no bundled TypeScript declaration.
import anotherJson from 'another-json';
import sdkPackage from 'matrix-js-sdk/package.json' with { type: 'json' };

const DOMAIN = 'org.cleanbookface.content.v2';
type JsonObject = Record<string, unknown>;
export interface SignedContent {
  version: 2;
  domain: typeof DOMAIN;
  room_id: string;
  sender: string;
  sender_device: string;
  payload: JsonObject;
  signatures: Record<string, Record<string, string>>;
}
/**
 * Deliberately isolated compatibility adapter for matrix-js-sdk 43.0.0.
 * RustCrypto.signObject is the SDK's Matrix canonical-JSON signer used by key
 * backup. getIdentity returns ONE native identity handle, so key and verified
 * status are observed together without separate key/status async races.
 * No private key is returned to JavaScript. Upgrade only with adapter tests.
 */
function backend(client: MatrixClient) {
  if (sdkPackage.version !== '43.0.0')
    throw new Error('Signed content requires reviewed Matrix SDK 43.0.0');
  const crypto = client.getCrypto();
  const candidate = crypto as unknown as {
    getOlmMachineOrThrow?: () => OlmMachine;
    signObject?: (object: JsonObject) => Promise<void>;
  };
  if (
    !crypto?.getVersion().startsWith('Rust SDK') ||
    typeof candidate.getOlmMachineOrThrow !== 'function' ||
    typeof candidate.signObject !== 'function'
  )
    throw new Error('Authenticated content signing is unavailable');
  return { machine: candidate.getOlmMachineOrThrow(), sign: candidate.signObject.bind(crypto) };
}
function obj(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid signed content');
  return value as JsonObject;
}
function base64(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error('Invalid signature encoding');
  const decoded = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (decoded.length !== length) throw new Error('Invalid signature length');
  return decoded;
}
function masterFromNative(identity: OwnUserIdentity | OtherUserIdentity, user: string): string {
  // All reads are synchronous on this one handle. Never await between them.
  if (
    !identity.isVerified() ||
    identity.hasVerificationViolation() ||
    ('identityNeedsUserApproval' in identity && identity.identityNeedsUserApproval())
  )
    throw new Error('Signing identity must be verified and unchanged');
  const key = obj(JSON.parse(identity.masterKey));
  const keys = obj(key.keys);
  if (
    key.user_id !== user ||
    !Array.isArray(key.usage) ||
    key.usage.length !== 1 ||
    key.usage[0] !== 'master' ||
    Object.keys(keys).length !== 1
  )
    throw new Error('Invalid verified master identity');
  const [keyId, publicKey] = Object.entries(keys)[0];
  if (typeof publicKey !== 'string' || keyId !== `ed25519:${publicKey}`)
    throw new Error('Invalid verified master key');
  base64(publicKey, 32);
  return publicKey;
}
async function verifiedMaster(client: MatrixClient, user: string): Promise<string> {
  await initAsync();
  const id = new UserId(user);
  let identity: OwnUserIdentity | OtherUserIdentity | undefined;
  try {
    identity = await backend(client).machine.getIdentity(id);
    if (!identity) throw new Error('Unknown signing identity');
    return masterFromNative(identity, user);
  } finally {
    identity?.free();
    id.free();
  }
}
function unsignedCanonical(value: JsonObject): string {
  const copy = { ...value };
  delete copy.signatures;
  delete copy.unsigned;
  return anotherJson.stringify(copy) as string;
}
async function verifyMasterSignature(
  value: JsonObject,
  sender: string,
  master: string,
): Promise<void> {
  const signatures = obj(value.signatures);
  const userSignatures = obj(signatures[sender]);
  const signature = userSignatures[`ed25519:${master}`];
  if (typeof signature !== 'string')
    throw new Error('Content requires a verified master signature');
  const key = await crypto.subtle.importKey('raw', base64(master, 32), { name: 'Ed25519' }, false, [
    'verify',
  ]);
  if (
    !(await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      base64(signature, 64),
      new TextEncoder().encode(unsignedCanonical(value)),
    ))
  )
    throw new Error('Content signature is invalid');
}
function validate(value: unknown, roomId: string, sender: string): SignedContent {
  const o = obj(value);
  if (
    Object.keys(o).sort().join(',') !==
      ['version', 'domain', 'room_id', 'sender', 'sender_device', 'payload', 'signatures']
        .sort()
        .join(',') ||
    o.version !== 2 ||
    o.domain !== DOMAIN ||
    o.room_id !== roomId ||
    o.sender !== sender ||
    typeof o.sender_device !== 'string' ||
    !o.sender_device ||
    o.sender_device.length > 255
  )
    throw new Error('Signed content context mismatch');
  obj(o.payload);
  obj(o.signatures);
  if (JSON.stringify(o).length > 32768) throw new Error('Signed content exceeds limit');
  return o as unknown as SignedContent;
}
export async function signContent(
  client: MatrixClient,
  requireVerifiedUser: (id: string) => Promise<void>,
  roomId: string,
  payload: JsonObject,
): Promise<SignedContent> {
  const sender = client.getUserId(),
    device = client.getDeviceId();
  if (!sender || !device) throw new Error('Authenticated device required');
  await requireVerifiedUser(sender);
  const master = await verifiedMaster(client, sender);
  const value: SignedContent = {
    version: 2,
    domain: DOMAIN,
    room_id: roomId,
    sender,
    sender_device: device,
    payload: structuredClone(payload),
    signatures: {},
  };
  await backend(client).sign(value as unknown as JsonObject);
  // signObject can return only a device signature when master secrets are not
  // cached. Never fall back: publication requires recovery/verified identity.
  validate(value, roomId, sender);
  await verifyMasterSignature(value as unknown as JsonObject, sender, master);
  await requireVerifiedUser(sender);
  if ((await verifiedMaster(client, sender)) !== master)
    throw new Error('Signing identity changed during publication');
  return value;
}
export async function verifyContent(
  client: MatrixClient,
  requireVerifiedUser: (id: string) => Promise<void>,
  roomId: string,
  sender: string,
  value: unknown,
): Promise<JsonObject> {
  const signed = validate(value, roomId, sender);
  await requireVerifiedUser(sender);
  const master = await verifiedMaster(client, sender);
  await verifyMasterSignature(signed as unknown as JsonObject, sender, master);
  await requireVerifiedUser(sender);
  if ((await verifiedMaster(client, sender)) !== master)
    throw new Error('Signing identity changed during verification');
  return signed.payload;
}
