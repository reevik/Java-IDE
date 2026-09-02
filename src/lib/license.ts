import { invoke } from "@tauri-apps/api/core";

/** License state, mirroring the reevik.net `/license/activate` response. */
export interface LicenseStatus {
  licensed: boolean;
  email: string | null;
  /** "active" | "not_found" | "unverified" | "invalid_email" | "none" */
  status: string;
}

const KEY = "license.state";

export const UNLICENSED: LicenseStatus = { licensed: false, email: null, status: "none" };

/** Load the last known license state from localStorage. */
export function loadLicense(): LicenseStatus {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return UNLICENSED;
    const p = JSON.parse(raw);
    if (p && typeof p.licensed === "boolean") {
      return { licensed: p.licensed, email: p.email ?? null, status: p.status ?? "none" };
    }
  } catch {
    /* corrupt or unavailable storage — treat as unlicensed */
  }
  return UNLICENSED;
}

export function saveLicense(s: LicenseStatus): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — non-fatal, state just won't persist */
  }
}

export function clearLicense(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Activate (or re-validate) a license online for the given email. The HTTP
 * call runs in Rust (`activate_license` command), so it isn't blocked by the
 * webview's CORS policy. Throws on network/server errors.
 */
export async function activateLicense(email: string): Promise<LicenseStatus> {
  const res = await invoke<LicenseStatus>("activate_license", { email: email.trim() });
  return {
    licensed: !!res.licensed,
    email: res.email ?? email.trim(),
    status: res.status ?? "none",
  };
}

/** Human-readable explanation for a status, for the dialog. */
export function statusMessage(status: string): string {
  switch (status) {
    case "active":
      return "Your subscription is active — thanks!";
    case "no_account":
      return "No account found for this email. Create one at app.ryos.io and subscribe.";
    case "inactive":
      return "This account doesn't have an active subscription. Subscribe at app.ryos.io.";
    case "expired":
      return "Your subscription has expired. Renew at app.ryos.io to reactivate.";
    case "invalid_email":
      return "That doesn't look like a valid email address.";
    default:
      return "This email is not licensed.";
  }
}
