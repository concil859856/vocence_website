import { useCallback, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { ImagePlus, Upload, X, Check } from 'lucide-react';
import { PLAYBOOK_COVERS } from '../data/playbookCovers';
import { dashboardApi, humanizeApiError } from '../services/dashboardApi';
import { PlaybookImageConsent } from './PlaybookImageConsent';

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

type Tab = 'gallery' | 'upload';

interface Props {
  playbookId: number;
  current: string | null | undefined;
  onClose: () => void;
  onSaved: (url: string) => void;
}

export function PlaybookCoverPicker({ playbookId, current, onClose, onSaved }: Props) {
  // Cookie-only auth: dashboardApi calls carry the session cookie
  // (credentials:'include'); there's no localStorage JWT to gate on.
  const [tab, setTab] = useState<Tab>('gallery');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConsent, setShowConsent] = useState(false);

  // Always re-prompt on every upload attempt (no localStorage cache)
  const switchToUpload = () => {
    setShowConsent(true);
  };

  // Upload-tab state
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);

  const onCropComplete = useCallback((_: Area, areaPx: Area) => setCroppedArea(areaPx), []);

  const onFile = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!ALLOWED_MIMES.has(file.type.toLowerCase())) {
      setError('Use a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`Image is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is 2 MB.`);
      return;
    }
    if (srcUrl) URL.revokeObjectURL(srcUrl);
    setSrcUrl(URL.createObjectURL(file));
    setZoom(1);
    setCrop({ x: 0, y: 0 });
  };

  const pickPreset = async (url: string) => {
    setSaving(true);
    setError(null);
    try {
      await dashboardApi.updatePlaybook(playbookId, { cover_image_url: url }, '');
      onSaved(url);
    } catch (e) {
      setError(humanizeApiError(e, 'Failed to update cover'));
    } finally {
      setSaving(false);
    }
  };

  const saveCrop = async () => {
    if (!srcUrl || !croppedArea) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await renderCroppedBlob(srcUrl, croppedArea);
      const updated = await dashboardApi.uploadPlaybookCover(playbookId, blob, '');
      onSaved(updated.cover_image_url || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to upload cover');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[90vh] bg-[#0f1115] border border-white/10 rounded-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08]">
          <h3 className="text-base font-semibold text-white">Choose a cover</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-[#A7B0B7]"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-3 border-b border-white/[0.08]">
          <button
            onClick={() => setTab('gallery')}
            className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${tab === 'gallery' ? 'bg-white/[0.06] text-white' : 'text-[#A7B0B7] hover:text-white'}`}
          >
            <span className="inline-flex items-center gap-2"><ImagePlus size={14} /> Gallery</span>
          </button>
          <button
            onClick={switchToUpload}
            className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${tab === 'upload' ? 'bg-white/[0.06] text-white' : 'text-[#A7B0B7] hover:text-white'}`}
          >
            <span className="inline-flex items-center gap-2"><Upload size={14} /> Upload your own</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'gallery' ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {PLAYBOOK_COVERS.map((url) => {
                const isCurrent = url === current;
                return (
                  <button
                    key={url}
                    type="button"
                    disabled={saving}
                    onClick={() => pickPreset(url)}
                    className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-all hover:scale-[1.02] ${isCurrent ? 'border-[#DFFF00]' : 'border-transparent hover:border-white/30'} disabled:opacity-50 disabled:pointer-events-none`}
                  >
                    <img loading="lazy" src={url} alt="" className="w-full h-full object-cover" />
                    {isCurrent && (
                      <div className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-[#DFFF00] text-[#07080A] flex items-center justify-center">
                        <Check size={14} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {!srcUrl ? (
                <label className="flex flex-col items-center justify-center gap-3 py-16 border border-dashed border-white/15 rounded-xl cursor-pointer hover:border-white/30 hover:bg-white/[0.02] transition-all">
                  <Upload size={32} className="text-[#A7B0B7]" />
                  <div className="text-center">
                    <p className="text-sm text-white">Click to upload</p>
                    <p className="text-xs text-[#666] mt-1">PNG, JPEG, or WebP, max 2 MB</p>
                  </div>
                  <input
                    type="file"
                    className="hidden"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => onFile(e.target.files?.[0])}
                  />
                </label>
              ) : (
                <>
                  <div className="relative w-full aspect-square bg-black rounded-xl overflow-hidden">
                    <Cropper
                      image={srcUrl}
                      crop={crop}
                      zoom={zoom}
                      aspect={1}
                      onCropChange={setCrop}
                      onZoomChange={setZoom}
                      onCropComplete={onCropComplete}
                      cropShape="rect"
                      showGrid
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-[#A7B0B7] w-10 shrink-0">Zoom</span>
                    <input
                      type="range" min={1} max={3} step={0.05} value={zoom}
                      onChange={(e) => setZoom(parseFloat(e.target.value))}
                      className="flex-1 accent-[#DFFF00]"
                    />
                    <button
                      type="button"
                      onClick={() => { if (srcUrl) URL.revokeObjectURL(srcUrl); setSrcUrl(null); setCroppedArea(null); }}
                      className="text-xs text-[#A7B0B7] hover:text-white px-3 py-1.5 rounded-lg hover:bg-white/5"
                    >
                      Pick a different image
                    </button>
                  </div>
                </>
              )}
              {error && (
                <div className="rounded-lg border border-red-400/30 bg-red-500/10 text-red-200 text-sm px-3 py-2">{error}</div>
              )}
            </div>
          )}
        </div>

        {/* Footer (only relevant for upload tab) */}
        {tab === 'upload' && srcUrl && (
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-white/[0.08]">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-xl text-[#A7B0B7] hover:text-white hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={saveCrop}
              disabled={saving || !croppedArea}
              className="px-4 py-2 text-sm rounded-xl bg-[#DFFF00] text-[#07080A] font-semibold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save cover'}
            </button>
          </div>
        )}
        {tab === 'gallery' && error && (
          <div className="px-5 py-3 border-t border-white/[0.08]">
            <div className="rounded-lg border border-red-400/30 bg-red-500/10 text-red-200 text-sm px-3 py-2">{error}</div>
          </div>
        )}
      </div>

      {showConsent && (
        <PlaybookImageConsent
          onCancel={() => setShowConsent(false)}
          onAccept={() => {
            setShowConsent(false);
            setTab('upload');
          }}
        />
      )}
    </div>
  );
}

/** Render the user's cropped region into a 1024-square JPEG/PNG blob for upload. */
async function renderCroppedBlob(srcUrl: string, area: Area): Promise<Blob> {
  const img = await loadImage(srcUrl);
  const target = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not available');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, target, target);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/png', 0.95);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
