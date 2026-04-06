import { deleteSecret, getSecret, setSecret } from "../secrets.js";

export function getJsonSecret<T>(key: string): T | null {
  const raw = getSecret(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setJsonSecret(key: string, value: unknown): void {
  setSecret(key, JSON.stringify(value));
}

export function clearJsonSecret(key: string): void {
  deleteSecret(key);
}
