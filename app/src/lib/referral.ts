const REF_KEY = 'vocence_referral_code';
const FP_KEY = 'vocence_device_fp';

export function captureReferralFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  if (ref && ref.trim()) {
    localStorage.setItem(REF_KEY, ref.trim());
  }
}

export function getStoredReferralCode(): string | undefined {
  return localStorage.getItem(REF_KEY) || undefined;
}

export function clearStoredReferralCode(): void {
  localStorage.removeItem(REF_KEY);
}

export function getDeviceFingerprint(): string {
  const stored = localStorage.getItem(FP_KEY);
  if (stored) return stored;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let canvasHash = '';
  if (ctx) {
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('vocence-fp', 2, 2);
    canvasHash = canvas.toDataURL();
  }

  const raw = [
    navigator.userAgent,
    navigator.language,
    screen.width,
    screen.height,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    canvasHash,
  ].join('|');

  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  const fp = Math.abs(hash).toString(36);
  localStorage.setItem(FP_KEY, fp);
  return fp;
}
