import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(pbkdf2);
const iterations = 210_000;
function passwordBytes(password: string): Buffer {
  if (password.length < 12 || password.length > 256 || Buffer.byteLength(password, 'utf8') > 1024 || password.includes('\u0000')) throw new Error('Choose a password of 12–256 characters');
  return Buffer.from(password, 'utf8');
}
export async function hashPassword(password: string) {
  const bytes = passwordBytes(password), salt = randomBytes(32);
  try { const hash = await derive(bytes, salt, iterations, 32, 'sha256'); return { passwordSalt: salt.toString('hex'), passwordHash: hash.toString('hex') }; }
  finally { bytes.fill(0); }
}
export async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(salt) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  let validLength = true; try { passwordBytes(password).fill(0); } catch { validLength = false; }
  const bytes = Buffer.from(validLength ? password : 'invalid-password-fixed-input', 'utf8');
  try { const hash = await derive(bytes, Buffer.from(salt, 'hex'), iterations, 32, 'sha256'); return timingSafeEqual(hash, Buffer.from(expected, 'hex')) && validLength; }
  finally { bytes.fill(0); }
}
