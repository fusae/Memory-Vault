import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha512';

export class CryptoService {
  private key: Buffer;

  constructor(passphrase: string, salt?: Buffer) {
    if (!salt) {
      salt = CryptoService.loadOrCreateSalt();
    }
    this.key = CryptoService.deriveKey(passphrase, salt);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: base64(iv + encrypted + authTag)
    return Buffer.concat([iv, encrypted, authTag]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  static deriveKey(passphrase: string, salt: Buffer): Buffer {
    return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
  }

  static loadOrCreateSalt(): Buffer {
    const saltDir = path.join(os.homedir(), '.memoryvault');
    const saltPath = path.join(saltDir, 'crypto-salt');

    if (fs.existsSync(saltPath)) {
      return fs.readFileSync(saltPath);
    }

    if (!fs.existsSync(saltDir)) {
      fs.mkdirSync(saltDir, { recursive: true });
    }

    const salt = randomBytes(SALT_LENGTH);
    fs.writeFileSync(saltPath, salt);
    return salt;
  }

  static getSaltPath(): string {
    return path.join(os.homedir(), '.memoryvault', 'crypto-salt');
  }
}
