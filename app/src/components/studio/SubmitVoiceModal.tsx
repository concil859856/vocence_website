/**
 * SubmitVoiceModal, submit a voice to the Community Voices catalog.
 *
 * Three sections in one modal (no wizard, adds friction for a small
 * form):
 *   1. Audio: record-in-browser OR upload. Live duration validated
 *      against the server bounds (MIN_AUDIO_DURATION_MS=8000,
 *      MAX=15000). The "Auto-transcribe" button feeds the recording
 *      back to /studio/transcribe and drops the result into ref_text
 *      so the user doesn't have to retype what they said.
 *   2. Avatar: square image upload. Server resizes to 512×512 WebP.
 *   3. Metadata: name, ≤30-char description, language picker.
 *
 * Submits multipart to POST /api/dashboard/voice-submissions; status
 * lands as 'pending' until an admin reviews it.
 */

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileAudio, ImageIcon, Loader2, Mic, Pause, Play, Square, X } from 'lucide-react';
import { dashboardApi } from '../../services/dashboardApi';
import { useAuth } from '../../contexts/AuthContext';
import { authFetch } from '../../services/authFetch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from 'sonner';

// Lite-transcribe cost, cheaper than the full Studio STT because the
// modal already caps audio at 15 s. Matches the backend default
// ``SUBMISSION_TRANSCRIBE_COST`` env var in voice_submissions.py;
// if you change it there, mirror the number here so the button label
// stays accurate.
const SUBMISSION_TRANSCRIBE_COST = 5;

// Constraints mirror the server (voice_submissions.py). Single source
// of truth is the server; we duplicate here so the UI can validate
// without a round-trip, but the server is authoritative.
const MIN_AUDIO_SEC = 8;
const MAX_AUDIO_SEC = 15;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_BYTES = 1 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 30;
const MAX_NAME_CHARS = 40;

// Languages the qwen3-clone-streaming pod accepts. Source of truth:
// dashboard-backend/voicechat_service.py:_CLONE_LANGUAGES (and the
// matching set in voice_submissions.py ALLOWED_LANGUAGES). ``Auto``
// is intentionally excluded, the submitter knows which language
// their clip is in, so making them pick one stops mis-tagged
// submissions from sneaking into the catalog.
const LANGUAGES = [
  'English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French',
  'German', 'Portuguese', 'Italian', 'Russian', 'Arabic',
];

// Used to validate dropped audio MIME types before we even try to
// measure the duration. Mirrors the server-side ALLOWED_AUDIO_MIMES
// in voice_submissions.py.
const ALLOWED_AUDIO_RE = /^audio\/(wav|x-wav|wave|mpeg|mp3|webm|ogg)$/;

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
};

export function SubmitVoiceModal({ open, onClose, onSubmitted }: Props) {
  const { user } = useAuth();

  // Audio state, either a recorded blob OR an uploaded file.
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioDurationSec, setAudioDurationSec] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Avatar state.
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  // Metadata.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [refText, setRefText] = useState('');
  const [language, setLanguage] = useState('English');

  // Process state.
  const [submitting, setSubmitting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  // Drag-over feedback for the audio + avatar drop zones.
  const [audioDrag, setAudioDrag] = useState(false);
  const [avatarDrag, setAvatarDrag] = useState(false);

  // Ownership/rights attestation, unchecked by default each open so
  // the user makes an explicit affirmation per submission. Stronger
  // bar than for voice cloning because an approved submission is
  // published publicly for every Vocence user to clone with.
  const [confirmedOwnership, setConfirmedOwnership] = useState(false);

  // Clean up object URLs to avoid leaks.
  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [avatarPreview]);

  // Reset form when modal closes.
  useEffect(() => {
    if (!open) {
      setAudioFile(null);
      setAudioDurationSec(0);
      setAvatarFile(null);
      setAvatarPreview(null);
      setName('');
      setDescription('');
      setRefText('');
      setLanguage('English');
      setSubmitting(false);
      setTranscribing(false);
      setRecording(false);
      setRecordingSec(0);
      setConfirmedOwnership(false);
      if (audioUrlRef.current) { URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = null; }
    }
  }, [open]);

  /** Probe an audio Blob for its true duration via a hidden <audio>. */
  const measureDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const el = new Audio();
      el.preload = 'metadata';
      el.onloadedmetadata = () => {
        const dur = el.duration && isFinite(el.duration) ? el.duration : 0;
        URL.revokeObjectURL(url);
        resolve(dur);
      };
      el.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
      el.src = url;
    });
  };

  const handleAudioFile = async (file: File) => {
    if (file.size > MAX_AUDIO_BYTES) {
      toast.error('Audio file too large', { description: `Max ${MAX_AUDIO_BYTES / 1024 / 1024} MB.` });
      return;
    }
    const dur = await measureDuration(file);
    setAudioFile(file);
    setAudioDurationSec(dur);
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = URL.createObjectURL(file);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const chunks: BlobPart[] = [];
      const mr = new MediaRecorder(stream);
      recorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'm4a' : 'wav';
        const file = new File([blob], `voice-sample.${ext}`, { type: blob.type });
        await handleAudioFile(file);
        setRecording(false);
        recorderRef.current = null;
      };
      mr.start();
      setRecording(true);
      setRecordingSec(0);
      timerRef.current = window.setInterval(() => {
        setRecordingSec((prev) => {
          const next = prev + 1;
          // Stop automatically at the upper bound so the user can't
          // record past the max, saves a "your recording is too long"
          // error after the fact.
          if (next >= MAX_AUDIO_SEC) stopRecording();
          return next;
        });
      }, 1000);
    } catch {
      toast.error('Microphone access denied');
      setRecording(false);
    }
  };

  const stopRecording = () => {
    if (timerRef.current != null) { clearInterval(timerRef.current); timerRef.current = null; }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  const handleAvatarFile = (file: File) => {
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error('Avatar file too large', { description: `Max ${MAX_AVATAR_BYTES / 1024 / 1024} MB.` });
      return;
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast.error('Use a JPG, PNG, or WebP image');
      return;
    }
    setAvatarFile(file);
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const autoTranscribe = async () => {
    if (!audioFile) {
      toast.error('Record or upload audio first');
      return;
    }
    const token = localStorage.getItem('vocence_token');
    if (!token) { toast.error('Sign in to use auto-transcribe'); return; }
    // Fast UX gate. Backend re-checks atomically.
    if (user && (user.credits ?? 0) < SUBMISSION_TRANSCRIBE_COST) {
      toast.error('Insufficient credits', {
        description: `Auto-transcribe uses ${SUBMISSION_TRANSCRIBE_COST} credits. You have ${user.credits ?? 0}.`,
      });
      return;
    }
    setTranscribing(true);
    try {
      const form = new FormData();
      form.append('audio', audioFile);
      form.append('language', language);
      // Dedicated lite endpoint, cheaper than /api/dashboard/transcribe
      // because the modal already caps audio at 15 s. Same STT pipeline
      // upstream, just a smaller bill.
      const res = await authFetch('/api/dashboard/voice-submissions/transcribe', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = (data?.text || '').trim();
      if (text) {
        setRefText(text);
        toast.success('Reference text filled in', {
          description: `${SUBMISSION_TRANSCRIBE_COST} credits deducted.`,
        });
      } else {
        toast.warning("Couldn't detect any speech");
      }
    } catch {
      toast.error('Transcription failed');
    } finally {
      setTranscribing(false);
    }
  };

  const canSubmit = (
    !!user && !!audioFile && !!avatarFile &&
    audioDurationSec >= MIN_AUDIO_SEC && audioDurationSec <= MAX_AUDIO_SEC &&
    name.trim().length > 0 && name.trim().length <= MAX_NAME_CHARS &&
    description.trim().length > 0 && description.trim().length <= MAX_DESCRIPTION_CHARS &&
    refText.trim().length > 0 &&
    LANGUAGES.includes(language) &&
    confirmedOwnership &&
    !submitting
  );

  const submit = async () => {
    if (!canSubmit || !audioFile || !avatarFile) return;
    const token = localStorage.getItem('vocence_token');
    if (!token) { toast.error('Sign in to submit'); return; }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('name', name.trim());
      form.append('description', description.trim());
      form.append('ref_text', refText.trim());
      form.append('language', language);
      form.append('audio', audioFile);
      form.append('avatar', avatarFile);
      await dashboardApi.submitVoice(form, token);
      toast.success('Submitted for review', {
        description: 'You\'ll get a notification once an admin approves or rejects it.',
      });
      onSubmitted?.();
      onClose();
    } catch (e) {
      const msg = (e as { userMessage?: string })?.userMessage || 'Submission failed';
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const audioInRange = audioDurationSec >= MIN_AUDIO_SEC && audioDurationSec <= MAX_AUDIO_SEC;

  // Generic file-drop handlers shared by both drop zones. We do it
  // per-zone so dropping an image on the audio area doesn't silently
  // replace audio (and vice versa), each zone enforces its own
  // accepted-type set.
  const handleAudioDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setAudioDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!ALLOWED_AUDIO_RE.test(f.type)) {
      toast.error('Drop a WAV, MP3, WebM, or OGG audio file');
      return;
    }
    void handleAudioFile(f);
  };
  const handleAvatarDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setAvatarDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) {
      toast.error('Drop a JPG, PNG, or WebP image');
      return;
    }
    handleAvatarFile(f);
  };

  return (
    // Outer overlay: fixed full-viewport flex container. ``items-start``
    // pins the modal's TOP to the viewport top (with a comfortable
    // ``pt-12`` so it doesn't sit flush against the edge), horizontally
    // centered. The body owns scrolling via ``flex-1 overflow-y-auto``
    // inside ``max-h-[88vh]``, the modal can never be taller than the
    // viewport, and the user sees the header at first glance.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 pb-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl max-h-[88vh] flex flex-col rounded-2xl border border-white/10 bg-[#0E1014] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header, fixed at top of modal */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-white">Submit your voice</h2>
            <p className="text-[11px] text-white/45 mt-0.5">
              Reviewed by admin · <span className="text-emerald-400 font-semibold">+300 bonus credits</span> on approval
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-white/55 hover:text-white hover:bg-white/[0.08]"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body, flex-1 fills remaining space, scrolls when needed.
            ``space-y-3`` (was 4-6) tightens vertical rhythm so the
            whole form lands above the fold on standard laptops. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 space-y-3">
          {/* Format hint, explicit line above the drop zone. Users
              who hit the "could not read audio duration" error often
              had uploaded an unsupported container; spelling out the
              accepted list upfront prevents the round-trip. */}
          <p className="text-[11px] text-white/55 -mb-1">
            <span className="text-white/45">Accepted formats:</span>{' '}
            <span className="text-white">WAV, MP3, WebM, OGG</span>
            <span className="text-white/45"> · {MIN_AUDIO_SEC}–{MAX_AUDIO_SEC} seconds · up to 5 MB</span>
          </p>

          {/* ---- AUDIO drop zone, clickable label opens file picker;
              Record button sits OUTSIDE the label so clicking it
              doesn't double-fire the file picker via the label
              association. */}
          {!audioFile ? (
            <div className="flex items-stretch gap-2">
              <label
                onDragOver={(e) => { e.preventDefault(); setAudioDrag(true); }}
                onDragLeave={() => setAudioDrag(false)}
                onDrop={handleAudioDrop}
                className={
                  'flex-1 flex items-center gap-3 cursor-pointer rounded-xl border-2 border-dashed transition-colors px-5 py-4 ' +
                  (audioDrag
                    ? 'border-[#DFFF00]/60 bg-[#DFFF00]/[0.04]'
                    : 'border-white/15 bg-white/[0.02] hover:border-white/30 hover:bg-white/[0.04]')
                }
              >
                <div className="w-10 h-10 rounded-lg bg-white/[0.06] flex items-center justify-center shrink-0">
                  <FileAudio size={18} className="text-white/55" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white">
                    <span className="text-[#DFFF00] font-medium">Drop audio file here</span>
                    <span className="text-white/55"> or click to browse</span>
                  </p>
                  <p className="text-[11px] text-white/45 mt-0.5">
                    WAV / MP3 / WebM / OGG · {MIN_AUDIO_SEC}–{MAX_AUDIO_SEC} s · ≤ 5 MB
                  </p>
                </div>
                <input
                  type="file"
                  accept="audio/wav,audio/mp3,audio/mpeg,audio/webm,audio/ogg"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleAudioFile(f);
                  }}
                />
              </label>
              {/* Record button is a sibling, not nested, guarantees
                  the two click targets never overlap. Same vertical
                  height as the drop zone so the row reads as paired. */}
              {!recording ? (
                <button
                  type="button"
                  onClick={startRecording}
                  className="shrink-0 self-center inline-flex flex-col items-center justify-center gap-0.5 rounded-lg bg-[#DFFF00] text-[#07080A] px-3 aspect-square h-auto text-[10px] font-semibold hover:brightness-110"
                  style={{ width: 56, height: 56 }}
                >
                  <Mic size={12} />
                  Record
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopRecording}
                  className="shrink-0 self-center inline-flex flex-col items-center justify-center gap-0.5 rounded-lg bg-red-500 text-white px-3 text-[10px] font-semibold hover:bg-red-600"
                  style={{ width: 56, height: 56 }}
                >
                  <Square size={11} className="fill-current" />
                  Stop · {recordingSec}s
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileAudio size={16} className="text-white/55 shrink-0" />
                  <p className="text-sm text-white truncate">{audioFile.name}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`text-xs ${audioInRange ? 'text-emerald-400' : 'text-red-400'}`}>
                    {audioInRange && <CheckCircle2 size={12} className="inline mr-1" />}
                    {audioDurationSec.toFixed(1)}s
                    {!audioInRange && ` (need ${MIN_AUDIO_SEC}–${MAX_AUDIO_SEC}s)`}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setAudioFile(null); setAudioDurationSec(0); if (audioUrlRef.current) { URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = null; } }}
                    className="text-white/45 hover:text-white"
                    aria-label="Remove audio"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              {audioUrlRef.current && <MiniAudioPlayer src={audioUrlRef.current} />}
            </div>
          )}

          {/* ---- AVATAR drop zone + preview, single compact row ---- */}
          <label
            onDragOver={(e) => { e.preventDefault(); setAvatarDrag(true); }}
            onDragLeave={() => setAvatarDrag(false)}
            onDrop={handleAvatarDrop}
            className={
              'flex items-center gap-3 cursor-pointer rounded-xl border-2 border-dashed transition-colors px-5 py-3 ' +
              (avatarDrag
                ? 'border-[#DFFF00]/60 bg-[#DFFF00]/[0.04]'
                : 'border-white/15 bg-white/[0.02] hover:border-white/30 hover:bg-white/[0.04]')
            }
          >
            <div className="w-10 h-10 rounded-lg bg-white/[0.06] overflow-hidden flex items-center justify-center shrink-0">
              {avatarPreview
                ? <img src={avatarPreview} alt="avatar preview" className="w-full h-full object-cover" />
                : <ImageIcon size={18} className="text-white/55" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white">
                <span className="text-[#DFFF00] font-medium">Drop voice avatar here</span>
                <span className="text-white/55"> or click to browse</span>
              </p>
              <p className="text-[11px] text-white/45 mt-0.5">
                {avatarFile
                  ? <span className="text-emerald-400">{avatarFile.name}</span>
                  : 'Square JPG / PNG / WebP · ≤ 1 MB · we crop + resize for you'}
              </p>
            </div>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAvatarFile(f);
              }}
            />
          </label>

          {/* ---- Metadata: name + description on one row, language + ref text below ---- */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-white/55 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME_CHARS}
                placeholder="e.g. Aria"
                className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#DFFF00]/30"
              />
            </div>
            <div>
              <label className="block text-[11px] text-white/55 mb-1">Description <span className="text-white/35">({description.length}/{MAX_DESCRIPTION_CHARS})</span></label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={MAX_DESCRIPTION_CHARS}
                placeholder="e.g. Warm radio host"
                className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#DFFF00]/30"
              />
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <label className="text-[11px] text-white/55">Language</label>
              {/* Warning sits beside the label, same row, smaller +
                  dimmer so it's informational rather than alarming.
                  Tells the user the clone model is language-gated. */}
              <span className="text-[10px] text-amber-300/80">
                Your audio must be in the selected language, clone won't work otherwise
              </span>
            </div>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="w-full bg-white/[0.04] border-white/10 text-sm text-white h-9 focus:ring-0 focus:border-[#DFFF00]/30">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[11px] text-white/55">Reference text (what the audio says)</label>
              <button
                type="button"
                onClick={autoTranscribe}
                disabled={!audioFile || transcribing}
                title={`Lite STT, costs ${SUBMISSION_TRANSCRIBE_COST} credits per run`}
                className="inline-flex items-center gap-1 text-[11px] text-[#DFFF00] hover:underline disabled:opacity-40 disabled:no-underline"
              >
                {transcribing
                  ? <><Loader2 size={11} className="animate-spin" /> Transcribing…</>
                  : <>Auto-transcribe <span className="text-white/45 font-normal">· {SUBMISSION_TRANSCRIBE_COST} cr</span></>}
              </button>
            </div>
            <textarea
              value={refText}
              onChange={(e) => setRefText(e.target.value)}
              rows={2}
              placeholder="The exact words spoken in the audio clip…"
              className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#DFFF00]/30 resize-y"
            />
          </div>
        </div>

        {/* Ownership attestation, must check before submit unlocks.
            Stronger bar than for one-off voice cloning because an
            approved submission gets published for every Vocence user
            to clone with. Re-affirmation per submission, not once-
            and-cached: a future submission might be a different voice
            with different rights. */}
        <div className="px-5 py-3 border-t border-white/10 shrink-0">
          <label className="flex items-start gap-2.5 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={confirmedOwnership}
              onChange={(e) => setConfirmedOwnership(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-white/20 bg-white/[0.04] text-[#DFFF00] focus:ring-1 focus:ring-[#DFFF00]/40 cursor-pointer accent-[#DFFF00] shrink-0"
            />
            <span className="text-[12px] leading-snug text-white/70 group-hover:text-white/85">
              I confirm I <span className="text-white font-medium">own this voice</span> or have the speaker's explicit permission to publish it. I'm not impersonating a public figure, celebrity, or anyone whose rights I don't hold. Once approved, this voice becomes publicly available for other Vocence users to use with.
            </span>
          </label>
        </div>

        <div className="px-5 py-3.5 border-t border-white/10 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-white/70 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            title={!confirmedOwnership && !submitting ? 'Confirm ownership above to enable submit' : undefined}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#DFFF00] text-[#07080A] px-5 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? <><Loader2 size={14} className="animate-spin" /> Submitting…</> : 'Submit for review'}
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * MiniAudioPlayer, dark-themed compact audio player for the
 * Submit-Your-Voice modal preview. Replaces the native ``<audio
 * controls>`` element which renders with browser-default white chrome
 * and looks broken against the dark modal.
 *
 * Hosts a hidden ``<audio>`` for actual playback; renders our own
 * play/pause button + scrubber + time. Click on the scrubber seeks;
 * dragging support is out of scope (a 15-second clip doesn't need it).
 */
function MiniAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  // Subscribe to playback events on the hidden <audio> element so the
  // UI stays in sync when audio ends / loops / errors out.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(el.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => { setPlaying(false); setCurrent(0); };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
    };
  }, [src]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play(); else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = pct * duration;
    setCurrent(el.currentTime);
  };

  const fmt = (s: number): string => {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, '0')}`;
  };

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-3 rounded-lg bg-white/[0.04] border border-white/[0.06] px-3 py-2">
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-[#DFFF00] text-[#07080A] hover:brightness-110"
      >
        {playing
          ? <Pause size={12} className="fill-current" />
          : <Play size={12} className="fill-current translate-x-[1px]" />}
      </button>
      <div
        onClick={seek}
        className="flex-1 h-1.5 rounded-full bg-white/[0.08] cursor-pointer overflow-hidden"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={duration || 0}
        aria-valuenow={current}
      >
        <div
          className="h-full bg-[#DFFF00] transition-all duration-100 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-white/55">
        {fmt(current)} / {fmt(duration)}
      </span>
    </div>
  );
}
