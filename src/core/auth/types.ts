export type ProviderAuthMode = "none" | "apiKey" | "oauth" | "externalToken";

export interface ProviderAuthMethod {
  type: string;
  label: string;
  description?: string;
}

export interface ProviderAuthState {
  active: ProviderAuthMode;
  available: boolean;
  configured: ProviderAuthMode[];
  expiresAt?: number;
  accountLabel?: string;
}

export interface ProviderAuthLoginOptions {
  log?: (line: string) => void;
  openUrl?: (url: string) => Promise<void> | void;
}

export interface ProviderAuthAdapter {
  listMethods(): ProviderAuthMethod[];
  getState(): Promise<ProviderAuthState>;
  checkAvailability(): Promise<boolean>;
  login(method: string, options?: ProviderAuthLoginOptions): Promise<void>;
  logout(): Promise<void>;
}
