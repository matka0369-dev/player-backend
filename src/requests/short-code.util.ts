import { randomBytes } from 'crypto';

// No 0/O/1/I/L: the code is read aloud and retyped from WhatsApp messages.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SHORT_CODE_LENGTH = 8;

export function generateShortCode(): string {
  const bytes = randomBytes(SHORT_CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const normalizeShortCode = (raw: string) => raw.trim().toUpperCase();
