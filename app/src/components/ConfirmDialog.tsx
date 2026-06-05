import { AlertTriangle } from 'lucide-react';

type Props = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;

  const confirmClass =
    confirmVariant === 'danger'
      ? 'bg-red-500/90 hover:bg-red-500 text-white border border-red-400/30'
      : 'btn-primary';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="presentation">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close dialog"
        onClick={busy ? undefined : onCancel}
        disabled={busy}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#12141a] shadow-[0_24px_80px_rgba(0,0,0,0.55)] p-6"
      >
        <div className="flex gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
            <AlertTriangle size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-dialog-title" className="text-lg font-semibold text-white tracking-tight">
              {title}
            </h2>
            <p id="confirm-dialog-desc" className="mt-2 text-sm text-[#A7B0B7] leading-relaxed">
              {message}
            </p>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          {cancelLabel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-[#A7B0B7] border border-white/15 hover:bg-white/5 hover:text-white transition-colors disabled:opacity-50"
            >
              {cancelLabel}
            </button>
          )}
          <button type="button" onClick={onConfirm} disabled={busy} className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-opacity disabled:opacity-50 ${confirmClass}`}>
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Please wait…
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
