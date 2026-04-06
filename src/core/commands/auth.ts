import { spawn } from "node:child_process";
import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import {
  describeProviderAuthState,
  getAuthEnabledProviders,
  getAuthProvider,
  listProviderAuthStatuses,
} from "../auth/index.js";
import { icon } from "../icons.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function formatExpiresAt(expiresAt?: number): string | null {
  if (!expiresAt) return null;
  const deltaMinutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
  return `${new Date(expiresAt).toLocaleString()} (${String(deltaMinutes)}m)`;
}

function openExternalUrl(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => resolve());
  });
}

async function buildStatusLines(providerId?: string): Promise<InfoPopupLine[]> {
  const statuses = await listProviderAuthStatuses();
  const filtered = providerId
    ? statuses.filter((entry) => entry.provider.id === providerId)
    : statuses;
  const lines: InfoPopupLine[] = [];

  for (const { provider, state } of filtered.filter((entry) => entry.provider.auth)) {
    if (lines.length > 0) {
      lines.push({ type: "spacer" }, { type: "separator" }, { type: "spacer" });
    }
    lines.push({ type: "header", label: provider.name });
    lines.push({ type: "entry", label: "Provider", desc: provider.id });
    lines.push({ type: "entry", label: "Status", desc: describeProviderAuthState(state) });
    lines.push({
      type: "entry",
      label: "Methods",
      desc:
        provider.auth
          ?.listMethods()
          .map((method) => method.label)
          .join(", ") ?? "",
      descColor: getThemeTokens().textSecondary,
    });
    if (state.expiresAt) {
      lines.push({
        type: "entry",
        label: "Expires",
        desc: formatExpiresAt(state.expiresAt) ?? "",
        descColor: getThemeTokens().textSecondary,
      });
    }
  }

  if (lines.length === 0) {
    lines.push({
      type: "text",
      label: "No auth-enabled providers.",
      color: getThemeTokens().textSecondary,
    });
  } else {
    lines.push(
      { type: "spacer" },
      { type: "separator" },
      { type: "spacer" },
      { type: "header", label: "Commands" },
      { type: "entry", label: "/auth login", desc: "start provider login" },
      { type: "entry", label: "/auth logout", desc: "remove provider oauth session" },
      { type: "entry", label: "/auth status", desc: "show provider auth status" },
    );
  }

  return lines;
}

async function handleAuthStatus(input: string, ctx: CommandContext): Promise<void> {
  const providerId =
    input
      .trim()
      .replace(/^\/auth(?:\s+status)?\s*/i, "")
      .trim() || undefined;
  ctx.openInfoPopup({
    title: providerId ? `Auth Status — ${providerId}` : "Auth Status",
    icon: icon("key"),
    lines: await buildStatusLines(providerId),
    labelWidth: 14,
  });
}

function chooseLoginMethod(providerId: string, ctx: CommandContext): void {
  const provider = getAuthProvider(providerId);
  if (!provider?.auth) {
    sysMsg(ctx, `Unknown auth provider: ${providerId}`);
    return;
  }
  const auth = provider.auth;
  const methods = auth.listMethods().filter((method) => method.type !== "apiKey");
  if (methods.length === 0) {
    sysMsg(ctx, `${provider.name} does not support interactive auth.`);
    return;
  }

  const startLogin = (methodType: string) => {
    const lines: InfoPopupLine[] = [
      {
        type: "text",
        label: `Authenticating ${provider.name}...`,
        color: getThemeTokens().textSecondary,
      },
    ];
    const update = () => {
      ctx.openInfoPopup({
        title: `Auth Login — ${provider.name}`,
        icon: icon("key"),
        lines: [...lines],
      });
    };
    update();
    auth
      .login(methodType, {
        log: (line) => {
          lines.push({ type: "text", label: line, color: getThemeTokens().textPrimary });
          update();
        },
        openUrl: openExternalUrl,
      })
      .then(() => {
        lines.push({
          type: "text",
          label: "Authentication complete.",
          color: getThemeTokens().success,
        });
        update();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        lines.push({
          type: "text",
          label: `Error: ${msg}`,
          color: getThemeTokens().brandSecondary,
        });
        update();
      });
  };

  if (methods.length === 1) {
    startLogin(methods[0]?.type ?? "");
    return;
  }

  ctx.openCommandPicker({
    title: `Auth Login — ${provider.name}`,
    icon: icon("key"),
    options: methods.map((method) => ({
      value: method.type,
      label: method.label,
      description: method.description,
    })),
    onSelect: startLogin,
  });
}

function handleAuthLogin(input: string, ctx: CommandContext): void {
  const raw = input
    .trim()
    .replace(/^\/auth\s+login\s*/i, "")
    .trim();
  if (!raw) {
    const providers = getAuthEnabledProviders();
    ctx.openCommandPicker({
      title: "Auth Login — Select Provider",
      icon: icon("key"),
      options: providers.map((provider) => ({ label: provider.name, value: provider.id })),
      onSelect: (providerId) => chooseLoginMethod(providerId, ctx),
    });
    return;
  }

  const parts = raw.split(/\s+/);
  const providerId = parts[0] ?? "";
  const explicitDevice = parts.includes("device");
  if (explicitDevice) {
    const provider = getAuthProvider(providerId);
    if (!provider?.auth) {
      sysMsg(ctx, `Unknown auth provider: ${providerId}`);
      return;
    }
    provider.auth
      .login("oauth-device", {
        log: (line) => sysMsg(ctx, line),
      })
      .then(() => sysMsg(ctx, `${provider.name} authentication complete.`))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        sysMsg(ctx, `Auth failed: ${msg}`);
      });
    return;
  }
  chooseLoginMethod(providerId, ctx);
}

async function performLogout(providerId: string, ctx: CommandContext): Promise<void> {
  const provider = getAuthProvider(providerId);
  if (!provider?.auth) {
    sysMsg(ctx, `Unknown auth provider: ${providerId}`);
    return;
  }
  const state = await provider.auth.getState();
  if (!state.configured.includes("oauth")) {
    ctx.openInfoPopup({
      title: "Auth Logout",
      icon: icon("key"),
      lines: [
        {
          type: "text",
          label: `No OAuth session for ${provider.name}.`,
          color: getThemeTokens().textSecondary,
        },
      ],
    });
    return;
  }
  await provider.auth.logout();
  ctx.openInfoPopup({
    title: "Auth Logout",
    icon: icon("key"),
    lines: [
      {
        type: "text",
        label: `Removed ${provider.name} OAuth session.`,
        color: getThemeTokens().success,
      },
    ],
  });
}

async function handleAuthLogout(input: string, ctx: CommandContext): Promise<void> {
  const providerId = input
    .trim()
    .replace(/^\/auth\s+logout\s*/i, "")
    .trim();
  if (providerId) {
    await performLogout(providerId, ctx);
    return;
  }

  const statuses = await listProviderAuthStatuses();
  const options = statuses
    .filter((entry) => entry.provider.auth && entry.state.configured.includes("oauth"))
    .map((entry) => ({
      label: entry.provider.name,
      value: entry.provider.id,
      description: describeProviderAuthState(entry.state),
    }));
  if (options.length === 0) {
    ctx.openInfoPopup({
      title: "Auth Logout",
      icon: icon("key"),
      lines: [
        {
          type: "text",
          label: "No OAuth sessions configured.",
          color: getThemeTokens().textSecondary,
        },
      ],
    });
    return;
  }

  ctx.openCommandPicker({
    title: "Auth Logout — Select Provider",
    icon: icon("key"),
    options,
    onSelect: (value) => {
      void performLogout(value, ctx);
    },
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/auth", handleAuthStatus);
  map.set("/auth status", handleAuthStatus);
  map.set("/auth login", handleAuthLogin);
  map.set("/auth logout", handleAuthLogout);
}

export function matchAuthPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/auth status ")) return handleAuthStatus;
  if (cmd.startsWith("/auth login ")) return handleAuthLogin;
  if (cmd.startsWith("/auth logout ")) return handleAuthLogout;
  return null;
}
