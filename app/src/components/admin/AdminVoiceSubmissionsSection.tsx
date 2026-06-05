/**
 * AdminVoiceSubmissionsSection, review queue for user-submitted voices.
 *
 * Table view + per-row drawer. Pending submissions sort first; approve
 * grants the submitter ``APPROVAL_CREDIT_BONUS`` credits via the
 * backend (see voice_submissions.py:admin_approve) AND fires a system
 * notification. Reject takes an optional reason that goes into the
 * rejection notification.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronRight, Clock, Loader2, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { dashboardApi, type AdminVoiceSubmission } from '../../services/dashboardApi';
import { toast } from 'sonner';


type Filter = 'all' | 'pending' | 'approved' | 'rejected';

export function AdminVoiceSubmissionsSection() {
  const [filter, setFilter] = useState<Filter>('pending');
  const [submissions, setSubmissions] = useState<AdminVoiceSubmission[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<AdminVoiceSubmission | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await dashboardApi.adminListVoiceSubmissions(filter);
      setSubmissions(res.submissions);
      setPendingCount(res.pending_count);
    } catch (e) {
      toast.error('Failed to load submissions', {
        description: (e as { userMessage?: string })?.userMessage,
      });
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const handleApprove = async (sub: AdminVoiceSubmission) => {
    try {
      const res = await dashboardApi.adminApproveVoiceSubmission(sub.id);
      toast.success(`Approved, ${res.credits_granted} credits granted`);
      setActive(null);
      await load();
    } catch (e) {
      toast.error('Approve failed', {
        description: (e as { userMessage?: string })?.userMessage,
      });
    }
  };

  const handleReject = async (sub: AdminVoiceSubmission, reason: string) => {
    try {
      await dashboardApi.adminRejectVoiceSubmission(sub.id, reason);
      toast.success('Rejected');
      setActive(null);
      await load();
    } catch (e) {
      toast.error('Reject failed', {
        description: (e as { userMessage?: string })?.userMessage,
      });
    }
  };

  return (
    <section className="glass-panel rounded-xl p-6 mb-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Voice submissions</h2>
          <p className="text-xs text-white/55 mt-0.5">
            Review user-contributed voices. Approvals grant 300 bonus credits to the submitter.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(['pending', 'all', 'approved', 'rejected'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                'text-xs px-2.5 py-1 rounded-full border transition-colors ' +
                (filter === f
                  ? 'bg-white/10 border-white/20 text-white'
                  : 'border-white/[0.08] text-white/55 hover:text-white hover:bg-white/[0.04]')
              }
            >
              {f === 'pending' && pendingCount > 0 ? `pending (${pendingCount})` : f}
            </button>
          ))}
        </div>
      </div>

      {loading && submissions.length === 0 ? (
        <div className="py-10 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-white/40" />
        </div>
      ) : submissions.length === 0 ? (
        <div className="py-10 text-center text-sm text-white/45">
          No {filter === 'all' ? '' : filter} submissions.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-white/45">
              <tr>
                <th className="text-left py-2 pr-3">Voice</th>
                <th className="text-left py-2 pr-3">Submitter</th>
                <th className="text-left py-2 pr-3">Language</th>
                <th className="text-left py-2 pr-3">Status</th>
                <th className="text-left py-2 pr-3">Submitted</th>
                <th className="text-right py-2"></th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id} className="border-t border-white/[0.05] hover:bg-white/[0.02]">
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-2.5">
                      <img src={s.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover bg-white/5" />
                      <div className="min-w-0">
                        <div className="text-white text-[13px] font-medium truncate">{s.name}</div>
                        <div className="text-[11px] text-white/45 truncate">{s.description}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-[12px] text-white/65">
                    {s.user_name || s.user_email || s.user_id.slice(0, 8)}
                  </td>
                  <td className="py-2.5 pr-3 text-[12px] text-white/65">{s.language}</td>
                  <td className="py-2.5 pr-3"><StatusPill status={s.status} /></td>
                  <td className="py-2.5 pr-3 text-[11px] text-white/45 whitespace-nowrap">
                    {new Date(s.created_at + (s.created_at.endsWith('Z') ? '' : 'Z')).toLocaleDateString()}
                  </td>
                  <td className="py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => setActive(s)}
                      className="inline-flex items-center text-white/55 hover:text-white"
                      aria-label="Review"
                    >
                      <ChevronRight size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <ReviewDrawer
          submission={active}
          onClose={() => setActive(null)}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </section>
  );
}


function StatusPill({ status }: { status: string }) {
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[11px]">
        <Clock size={10} /> pending
      </span>
    );
  }
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px]">
        <CheckCircle2 size={10} /> approved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 text-[11px]">
      <X size={10} /> rejected
    </span>
  );
}


function ReviewDrawer({
  submission, onClose, onApprove, onReject,
}: {
  submission: AdminVoiceSubmission;
  onClose: () => void;
  onApprove: (s: AdminVoiceSubmission) => void;
  onReject: (s: AdminVoiceSubmission, reason: string) => void;
}) {
  const [rejectMode, setRejectMode] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-end p-0 sm:p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full sm:w-[480px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#0E1014] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3.5 border-b border-white/10 bg-[#0E1014]/95 backdrop-blur">
          <h3 className="text-sm font-semibold text-white">Review submission</h3>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-white/55 hover:text-white hover:bg-white/[0.08]"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <img src={submission.avatar_url} alt="" className="w-16 h-16 rounded-full object-cover bg-white/5" />
            <div className="flex-1 min-w-0">
              <h4 className="text-white font-semibold text-base truncate">{submission.name}</h4>
              <p className="text-sm text-white/65 mt-0.5">{submission.description}</p>
              <p className="text-xs text-white/45 mt-1">
                {submission.user_name || submission.user_email} · {submission.language} · {(submission.audio_duration_ms / 1000).toFixed(1)}s
              </p>
            </div>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wider text-white/45 mb-1">Audio</p>
            <audio src={submission.audio_url} controls className="w-full" />
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wider text-white/45 mb-1">Reference text</p>
            <p className="text-sm text-white/85 leading-snug bg-white/[0.03] rounded-lg p-3 whitespace-pre-wrap">{submission.ref_text}</p>
          </div>

          {submission.status !== 'pending' && (
            <div className="text-xs text-white/55 border-t border-white/[0.05] pt-3">
              <StatusPill status={submission.status} />
              {submission.reject_reason && (
                <p className="mt-2"><span className="text-white/45">Reason:</span> {submission.reject_reason}</p>
              )}
              {submission.reviewed_by && (
                <p className="mt-1"><span className="text-white/45">Reviewed by:</span> {submission.reviewed_by}</p>
              )}
            </div>
          )}
        </div>

        {submission.status === 'pending' && (
          <div className="sticky bottom-0 px-5 py-3.5 border-t border-white/10 bg-[#0E1014]/95 backdrop-blur">
            {!rejectMode ? (
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRejectMode(true)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] text-white/85 px-4 py-2 text-sm font-medium hover:bg-white/[0.10]"
                >
                  <ThumbsDown size={14} /> Reject
                </button>
                <button
                  type="button"
                  onClick={() => onApprove(submission)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110"
                >
                  <ThumbsUp size={14} /> Approve & grant 300 credits
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Reason for rejection (sent to submitter)"
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#DFFF00]/30 resize-y"
                />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setRejectMode(false)} className="px-3 py-1.5 text-sm text-white/65 hover:text-white">Cancel</button>
                  <button
                    type="button"
                    onClick={() => onReject(submission, reason)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-red-500 text-white px-4 py-1.5 text-sm font-semibold hover:bg-red-600"
                  >
                    Reject submission
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
