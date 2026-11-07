import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64, options);
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password, hash) {
  const [kind, salt, hex] = hash.split("$");
  if (kind !== "scrypt" || !salt || !hex) return false;
  const actual = await scrypt(password, salt, 64, options);
  const expected = Buffer.from(hex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
