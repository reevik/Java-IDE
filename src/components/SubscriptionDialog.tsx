import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { activateLicense, statusMessage, type LicenseStatus } from "../lib/license";

const SUBSCRIBE_URL = "https://app.ryos.io/register";

interface Props {
  current: LicenseStatus;
  onClose: () => void;
  onActivated: (status: LicenseStatus) => void;
}

/** Help ▸ Manage Subscription: activate a license by email against reevik.net. */
export default function SubscriptionDialog({ current, onClose, onActivated }: Props) {
  const [email, setEmail] = useState(current.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LicenseStatus | null>(null);

  const shown = result ?? current;

  async function activate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const status = await activateLicense(email);
      setResult(status);
      onActivated(status);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="switch-dialog flex w-[440px] flex-col rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[color:var(--line)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Manage Subscription</h2>
          <span
            className={
              "rounded px-2 py-0.5 text-[11px] font-medium " +
              (shown.licensed
                ? "bg-[color:var(--ok,#1a7f37)]/15 text-[var(--ok,#1a7f37)]"
                : "bg-[color:var(--warn,#b45309)]/15 text-[var(--warn,#b45309)]")
            }
          >
            {shown.licensed ? "Licensed" : "Unlicensed"}
          </span>
        </div>

        <div className="flex flex-col gap-3 p-5">
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            Enter the email you subscribed with at reevik.net to activate your license.
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-tertiary)]">Email</span>
            <input
              type="email"
              autoFocus
              value={email}
              disabled={busy}
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void activate();
              }}
              className="rounded-md border border-[color:var(--line)] bg-[var(--bg-input,transparent)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[color:var(--accent,#3b82f6)]"
            />
          </label>

          {error && <p className="text-[12px] text-[var(--warn,#b45309)]">{error}</p>}

          {result && !error && (
            <p
              className={
                "text-[12px] " +
                (result.licensed ? "text-[var(--ok,#1a7f37)]" : "text-[var(--warn,#b45309)]")
              }
            >
              {statusMessage(result.status)}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[color:var(--line)] px-4 py-3">
          <button
            type="button"
            onClick={() => void openUrl(SUBSCRIBE_URL)}
            title="Open the subscription page at ryos.io"
            className="text-[12px] text-[var(--accent,#3b82f6)] hover:underline"
          >
            Don't have a subscription? Subscribe ↗
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-[12.5px] text-[var(--text-secondary)] hover:bg-[color:var(--hover,rgba(0,0,0,0.05))]"
            >
              Close
            </button>
            <button
              type="button"
              disabled={busy || email.trim() === ""}
              onClick={() => void activate()}
              className="rounded-md bg-[color:var(--accent,#3b82f6)] px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50"
            >
              {busy ? "Activating…" : "Activate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
