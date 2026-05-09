import { useEffect, useRef, useState } from 'react';
import type { SubnetGraphActivity, SubnetGraphNode, SubnetGraphSnapshot } from '../services/dashboardApi';

type PositionedNode = SubnetGraphNode & { x: number; y: number };

const VALIDATOR_PALETTE = ['#2ee1e8', '#7dd3fc', '#D1F840', '#f59e0b', '#f472b6', '#a78bfa'];
const ACTIVITY_COLORS: Record<string, string> = {
  evaluation: '#7dd3fc',
  evaluation_result: '#2ee1e8',
  weight_setting: '#D1F840',
  weight_setting_complete: '#f59e0b',
};

function shortHotkey(hotkey?: string | null): string {
  if (!hotkey) return '—';
  if (hotkey.length <= 12) return hotkey;
  return `${hotkey.slice(0, 6)}…${hotkey.slice(-4)}`;
}

function statusLabel(node: SubnetGraphNode): string {
  if (node.node_type === 'miner') return node.valid ? 'Valid' : 'Invalid';
  return node.status;
}

function buildValidatorColors(nodes: SubnetGraphNode[]): Record<string, string> {
  const validators = nodes
    .filter((n) => n.node_type === 'validator' && n.hotkey)
    .sort((a, b) => String(a.hotkey).localeCompare(String(b.hotkey)));
  const colors: Record<string, string> = {};
  validators.forEach((node, index) => {
    colors[String(node.hotkey)] = VALIDATOR_PALETTE[index % VALIDATOR_PALETTE.length];
  });
  return colors;
}

function buildPositions(nodes: SubnetGraphNode[]): Record<string, PositionedNode> {
  const validators = nodes.filter((n) => n.node_type === 'validator');
  const buckets = nodes.filter((n) => n.node_type === 'bucket');
  const miners = nodes.filter((n) => n.node_type === 'miner');
  const byId: Record<string, PositionedNode> = {};

  const ownerBand = { x1: 430, x2: 610, y: 62 };
  const chainBand = { x: 836, y: 68 };
  const validatorBand = { x1: 84, x2: 956, y: 126 };
  const bucketBandOffset = 48;
  // Miner band extends upward toward the buckets (y≈174 + r24 = 198) so
  // dense subnets (200+ miners) have vertical room without forcing the
  // node radius down. Bottom-anchored layout below keeps the few-miners
  // case visually unchanged (rows still start at y=394 when count is low).
  const minerBand = { x1: 76, x2: 964, y1: 230, y2: 474 };

  const owner = nodes.find((n) => n.id === 'owner-api');
  const subtensor = nodes.find((n) => n.id === 'subtensor');
  if (owner) {
    byId[owner.id] = {
      ...owner,
      x: (ownerBand.x1 + ownerBand.x2) / 2,
      y: ownerBand.y,
    };
  }
  if (subtensor) byId[subtensor.id] = { ...subtensor, x: chainBand.x, y: chainBand.y };

  validators.forEach((node, index) => {
    const count = Math.max(1, validators.length);
    const t = count === 1 ? 0.5 : index / (count - 1);
    const x = validatorBand.x1 + t * (validatorBand.x2 - validatorBand.x1);
    byId[node.id] = { ...node, x, y: validatorBand.y };
  });

  buckets.forEach((node) => {
    const validatorId = `validator:${node.validator_hotkey}`;
    const validator = byId[validatorId];
    const x = validator ? validator.x : 160;
    const y = validator ? validator.y + bucketBandOffset : validatorBand.y + bucketBandOffset;
    byId[node.id] = { ...node, x, y };
  });

  const minerCount = Math.max(1, miners.length);
  const aspectWidth = minerBand.x2 - minerBand.x1;
  const aspectHeight = minerBand.y2 - minerBand.y1;
  const columns = Math.max(
    8,
    Math.min(16, Math.ceil(Math.sqrt(minerCount * (aspectWidth / Math.max(1, aspectHeight)))))
  );
  const rows = Math.max(1, Math.ceil(minerCount / columns));
  const xGap = columns > 1 ? aspectWidth / (columns - 1) : 0;
  // 40 = no-overlap spacing for the r=11 node (diameter 22) with margin.
  // When miner count grows past what fits in (y2 - y1) at this gap, the
  // gap shrinks to fit the band — overlap is acceptable per the design.
  const yGap = rows > 1 ? Math.min(40, aspectHeight / (rows - 1)) : 0;
  // Bottom-anchor so few miners sit at the visual bottom (y≈394, matching
  // the original layout) and only dense subnets reach upward toward the
  // bucket band.
  const minerYStart = minerBand.y2 - (rows - 1) * yGap;
  miners.forEach((node, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const x = minerBand.x1 + col * xGap;
    const y = minerYStart + row * yGap;
    byId[node.id] = { ...node, x, y };
  });

  return byId;
}

function edgePath(from: PositionedNode, to: PositionedNode): string {
  const dx = Math.abs(to.x - from.x) * 0.35;
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + dx}, ${to.x} ${to.y - dx}, ${to.x} ${to.y}`;
}

function secondsSince(iso: string, nowMs: number): number {
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - started) / 1000);
}

function getEvaluationPhase(activity: SubnetGraphActivity, nowMs: number): 'preflight' | 'fanout' | 'judging' {
  const elapsedSeconds = secondsSince(activity.started_at, nowMs);
  const preflightWindowSeconds = 6;
  const fanoutWindowSeconds = 15;
  if (elapsedSeconds <= preflightWindowSeconds) return 'preflight';
  if (elapsedSeconds <= preflightWindowSeconds + fanoutWindowSeconds) return 'fanout';
  return 'judging';
}

function getWeightSettingPhase(activity: SubnetGraphActivity, nowMs: number): 'owner' | 'buckets' | 'chain' {
  const elapsedSeconds = secondsSince(activity.started_at, nowMs);
  const ownerWindowSeconds = 4;
  const bucketWindowSeconds = 15;
  if (elapsedSeconds <= ownerWindowSeconds) return 'owner';
  if (elapsedSeconds <= ownerWindowSeconds + bucketWindowSeconds) return 'buckets';
  return 'chain';
}

function activityPriority(activity: SubnetGraphActivity): number {
  switch (activity.activity_type) {
    case 'weight_setting':
      return 4;
    case 'evaluation_result':
      return 3;
    case 'evaluation':
      return 2;
    case 'weight_setting_complete':
      return 1;
    default:
      return 0;
  }
}

function getActivityEvaluationId(activity: SubnetGraphActivity): string | null {
  const payloadId = activity.payload?.evaluation_id;
  if (typeof payloadId === 'string' && payloadId.trim()) return payloadId.trim();

  const parts = activity.activity_key.split(':');
  if ((activity.activity_type === 'evaluation' || activity.activity_type === 'evaluation_result') && parts.length >= 3) {
    return parts.slice(2).join(':') || null;
  }
  return null;
}

function normalizeActivitiesForGraph(activities: SubnetGraphActivity[]): SubnetGraphActivity[] {
  const sorted = [...activities].sort((a, b) => {
    const aStarted = new Date(a.started_at).getTime();
    const bStarted = new Date(b.started_at).getTime();
    if (bStarted !== aStarted) return bStarted - aStarted;
    return activityPriority(b) - activityPriority(a);
  });

  const seenValidators = new Set<string>();
  const normalized: SubnetGraphActivity[] = [];
  for (const activity of sorted) {
    if (seenValidators.has(activity.validator_hotkey)) continue;
    seenValidators.add(activity.validator_hotkey);
    normalized.push(activity);
  }
  return normalized;
}

function buildEvaluatingValidatorSet(activities: SubnetGraphActivity[], nowMs: number): Set<string> {
  const resultKeys = new Set<string>();

  for (const activity of activities) {
    if (activity.activity_type !== 'evaluation_result') continue;
    const evaluationId = getActivityEvaluationId(activity);
    if (!evaluationId) continue;
    resultKeys.add(`${activity.validator_hotkey}:${evaluationId}`);
  }

  const evaluating = new Set<string>();
  for (const activity of activities) {
    if (activity.activity_type !== 'evaluation') continue;
    if (getEvaluationPhase(activity, nowMs) !== 'judging') continue;
    const evaluationId = getActivityEvaluationId(activity);
    if (!evaluationId) {
      evaluating.add(activity.validator_hotkey);
      continue;
    }

    if (resultKeys.has(`${activity.validator_hotkey}:${evaluationId}`)) continue;

    evaluating.add(activity.validator_hotkey);
  }

  return evaluating;
}

function buildActivityEdges(
  positions: Record<string, PositionedNode>,
  activities: SubnetGraphActivity[],
  validatorColors: Record<string, string>,
  nowMs: number
): Array<{ key: string; d: string; color: string; width: number; dash: string }> {
  const edges: Array<{ key: string; d: string; color: string; width: number; dash: string }> = [];

  for (const activity of activities) {
    const validator = positions[`validator:${activity.validator_hotkey}`];
    const owner = positions['owner-api'];
    const subtensor = positions['subtensor'];
    if (!validator) continue;
    const validatorColor = validatorColors[activity.validator_hotkey] ?? '#7dd3fc';

    if (activity.activity_type === 'evaluation') {
      const phase = getEvaluationPhase(activity, nowMs);
      if (owner && phase === 'preflight') {
        edges.push({
          key: `${activity.activity_key}:owner`,
          d: edgePath(validator, owner),
          color: validatorColor,
          width: 2.5,
          dash: '6 10',
        });
      }
      if (phase === 'fanout') {
        const minerHotkeys = (activity.payload.miner_hotkeys as string[] | undefined) ?? [];
        minerHotkeys.forEach((hotkey) => {
          const miner = positions[`miner:${hotkey}`];
          if (!miner) return;
          edges.push({
            key: `${activity.activity_key}:miner:${hotkey}`,
            d: edgePath(validator, miner),
            color: validatorColor,
            width: 2,
            dash: '4 10',
          });
        });
      }
    } else if (activity.activity_type === 'evaluation_result') {
      const bucket = positions[`bucket:${activity.validator_hotkey}`];
      if (bucket) {
        edges.push({
          key: `${activity.activity_key}:bucket`,
          d: edgePath(validator, bucket),
          color: validatorColor,
          width: 2.5,
          dash: '3 8',
        });
      }
      if (owner) {
        edges.push({
          key: `${activity.activity_key}:owner`,
          d: edgePath(validator, owner),
          color: validatorColor,
          width: 2.5,
          dash: '3 8',
        });
      }
    } else if (activity.activity_type === 'weight_setting') {
      const phase = getWeightSettingPhase(activity, nowMs);
      if (owner && phase === 'owner') {
        edges.push({
          key: `${activity.activity_key}:owner`,
          d: edgePath(validator, owner),
          color: validatorColor,
          width: 3,
          dash: '8 12',
        });
      }
      if (phase === 'buckets') {
        const targets = (activity.payload.target_validator_hotkeys as string[] | undefined) ?? [];
        targets.forEach((hotkey) => {
          const bucket = positions[`bucket:${hotkey}`];
          if (!bucket) return;
          edges.push({
            key: `${activity.activity_key}:bucket:${hotkey}`,
            d: edgePath(validator, bucket),
            color: validatorColor,
            width: 2.5,
            dash: '6 12',
          });
        });
      }
      if (subtensor && phase === 'chain') {
        edges.push({
          key: `${activity.activity_key}:subtensor`,
          d: edgePath(validator, subtensor),
          color: validatorColor,
          width: 3,
          dash: '10 14',
        });
      }
    } else if (activity.activity_type === 'weight_setting_complete' && subtensor) {
      edges.push({
        key: `${activity.activity_key}:subtensor`,
        d: edgePath(validator, subtensor),
        color: validatorColor,
        width: 3,
        dash: '2 6',
      });
    }
  }
  return edges;
}

export function LiveSubnetMap({
  graph,
  useFallbackData,
}: {
  graph: SubnetGraphSnapshot | null;
  useFallbackData: boolean;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [parallax, setParallax] = useState({ x: 0, y: 0 });
  const mapSurfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => {
      setNowMs(Date.now() - serverClockOffsetMs);
    }, 500);
    return () => window.clearInterval(t);
  }, [serverClockOffsetMs]);

  useEffect(() => {
    if (!graph?.generated_at) return;
    const generatedMs = new Date(graph.generated_at).getTime();
    if (Number.isNaN(generatedMs)) return;
    const offset = Date.now() - generatedMs;
    setServerClockOffsetMs(offset);
    setNowMs(Date.now() - offset);
  }, [graph?.generated_at]);

  if (useFallbackData || !graph) {
    return (
      <div className="rounded-xl border border-[#27272a] bg-[radial-gradient(circle_at_12%_12%,rgba(46,225,232,0.08),transparent_28%),radial-gradient(circle_at_88%_8%,rgba(125,211,252,0.07),transparent_30%),linear-gradient(160deg,#05070d_0%,#070b14_54%,#05070e_100%)] px-6 py-10 text-sm text-gray-500">
        Live subnet map becomes active when the dashboard backend receives live graph activity leases from the owner API.
      </div>
    );
  }

  const positions = buildPositions(graph.nodes);
  const validatorColors = buildValidatorColors(graph.nodes);
  const visibleActivities = normalizeActivitiesForGraph(graph.activities);
  const edges = buildActivityEdges(positions, visibleActivities, validatorColors, nowMs);
  const evaluatingValidators = buildEvaluatingValidatorSet(graph.activities, nowMs);
  const selectedNode =
    (selectedNodeId ? graph.nodes.find((node) => node.id === selectedNodeId) : null) ??
    graph.nodes.find((node) => node.node_type === 'validator') ??
    null;
  const recentActivities = graph.activities.slice(0, 6);
  const handleMapMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const el = mapSurfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
    const py = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
    setParallax({ x: px * 16, y: py * 12 });
  };

  return (
    <div className="relative rounded-xl border border-[#27272a] bg-[linear-gradient(160deg,#04060c_0%,#060a13_52%,#04060d_100%)] shadow-[0_10px_36px_rgba(0,0,0,0.38),inset_0_1px_0_rgba(255,255,255,0.02)] overflow-hidden">
      <style>{`
        @keyframes subnetFlow {
          from { stroke-dashoffset: 800; }
          to { stroke-dashoffset: 0; }
        }
        @keyframes mapCardBgShift {
          0% { transform: translate3d(-2%, -1%, 0) scale(1); opacity: 0.42; }
          50% { transform: translate3d(2%, 1%, 0) scale(1.03); opacity: 0.62; }
          100% { transform: translate3d(-2%, -1%, 0) scale(1); opacity: 0.42; }
        }
        @keyframes mapSurfaceDrift {
          0% { background-position: 0% 0%, 100% 0%, 0% 0%; }
          50% { background-position: 12% 8%, 88% 4%, 100% 100%; }
          100% { background-position: 0% 0%, 100% 0%, 0% 0%; }
        }
        @keyframes starDriftSlow {
          0% { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(-80px, -42px, 0); }
        }
        @keyframes starDriftFast {
          0% { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(-140px, -78px, 0); }
        }
        @keyframes orbPulse {
          0%, 100% {
            transform: scale(1);
            opacity: 0.82;
            filter: blur(0px);
          }
          50% {
            transform: scale(1.09);
            opacity: 1;
            filter: blur(0.2px);
          }
        }
        @keyframes hudFloat {
          0%, 100% { transform: translateY(0px); opacity: 0.36; }
          50% { transform: translateY(-3px); opacity: 0.52; }
        }
        @keyframes liveBadgePulse {
          0%, 100% {
            opacity: 1;
            transform: scale(1);
            box-shadow:
              0 0 0 0 rgba(125, 211, 252, 0.26),
              0 0 18px 2px rgba(125, 211, 252, 0.16),
              inset 0 0 0 1px rgba(125, 211, 252, 0.24);
            background: rgba(125, 211, 252, 0.14);
            color: #d7f4ff;
          }
          50% {
            opacity: 1;
            transform: scale(1.035);
            box-shadow:
              0 0 0 6px rgba(125, 211, 252, 0.10),
              0 0 34px 6px rgba(125, 211, 252, 0.28),
              inset 0 0 0 1px rgba(125, 211, 252, 0.44);
            background: rgba(125, 211, 252, 0.24);
            color: #ffffff;
          }
        }
        @keyframes eventCardPulse {
          0%, 100% {
            background: rgba(13, 18, 27, 0.94);
            border-color: rgba(63, 63, 70, 0.95);
            box-shadow:
              inset 0 0 0 1px rgba(255, 255, 255, 0.03),
              0 0 0 0 rgba(125, 211, 252, 0.00);
          }
          50% {
            background: rgba(22, 30, 44, 1);
            border-color: rgba(125, 211, 252, 0.32);
            box-shadow:
              inset 0 0 0 1px rgba(125, 211, 252, 0.14),
              0 0 24px 0 rgba(125, 211, 252, 0.12),
              0 0 42px 0 rgba(125, 211, 252, 0.06);
          }
        }
      `}</style>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 12% 10%, rgba(46,225,232,0.10), transparent 28%), radial-gradient(circle at 86% 0%, rgba(125,211,252,0.09), transparent 34%), radial-gradient(circle at 60% 120%, rgba(46,225,232,0.06), transparent 42%)',
          animation: 'mapCardBgShift 14s ease-in-out infinite',
        }}
      />
      <div className="border-b border-[#27272a] px-6 py-3.5 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] border border-[#7dd3fc]/25"
            style={{ animation: 'liveBadgePulse 1.8s ease-in-out infinite' }}
          >
            Live subnet map
          </div>
          <h2 className="text-sm font-medium text-gray-300">Real-time subnet operations graph</h2>
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-400">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#27272a] bg-[#0f1420] px-2.5 py-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[#7dd3fc]" />
              Edge = active request
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#27272a] bg-[#0f1420] px-2.5 py-1">
              <span className="inline-block h-3 w-3 rounded-full border border-[#7dd3fc] border-t-transparent animate-spin" />
              Spinner = evaluating
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-full border border-[#27272a] bg-[#0f1420] px-3 py-1.5 text-gray-300">
            Validators {graph.nodes.filter((n) => n.node_type === 'validator').length}
          </span>
          <span className="rounded-full border border-[#27272a] bg-[#0f1420] px-3 py-1.5 text-gray-300">
            Miners {graph.nodes.filter((n) => n.node_type === 'miner').length}
          </span>
          <span className="rounded-full border border-[#27272a] bg-[#0f1420] px-3 py-1.5 text-gray-300">
            Live actions {graph.activities.length}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px]">
        <div
          ref={mapSurfaceRef}
          className="relative min-h-[392px]"
          onMouseMove={handleMapMouseMove}
          onMouseLeave={() => setParallax({ x: 0, y: 0 })}
          style={{
            background:
              'radial-gradient(circle at 50% 50%, rgba(90,120,140,0.05), transparent 60%), linear-gradient(180deg, #020305 0%, #04070b 60%, #020305 100%)',
            backgroundSize: '150% 150%, 140% 140%, 100% 100%',
            animation: 'mapSurfaceDrift 16s ease-in-out infinite',
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at calc(30% + 50px) calc(42% + 50px), rgba(34,211,238,0.08) 0%, rgba(34,211,238,0.04) 4%, rgba(34,211,238,0.018) 7%, rgba(34,211,238,0.00) 11%)',
              transform: `translate3d(${parallax.x}px, ${parallax.y}px, 0)`,
              transition: 'transform 220ms ease-out',
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{
              left: 'calc(30% + 50px)',
              top: 'calc(42% + 50px)',
              width: 66,
              height: 66,
              borderRadius: '9999px',
              background:
                'radial-gradient(circle, rgba(46,225,232,0.30) 0%, rgba(46,225,232,0.13) 30%, rgba(46,225,232,0.035) 58%, rgba(46,225,232,0.00) 82%)',
              boxShadow:
                '0 0 8px rgba(46,225,232,0.14), 0 0 18px rgba(46,225,232,0.08), inset 0 0 6px rgba(255,255,255,0.05)',
              transform: `translate(-50%, -50%) translate3d(${parallax.x * 1.2}px, ${parallax.y * 1.2}px, 0)`,
              transition: 'transform 220ms ease-out',
              animation: 'orbPulse 4.8s ease-in-out infinite',
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              backgroundImage:
                'radial-gradient(circle, rgba(160,170,184,0.22) 0.7px, transparent 1.2px), radial-gradient(circle, rgba(148,163,184,0.18) 0.8px, transparent 1.35px)',
              backgroundSize: '48px 48px, 84px 84px',
              backgroundPosition: '0 0, 36px 22px',
              animation: 'starDriftSlow 46s linear infinite',
              transform: `translate3d(${parallax.x * 0.15}px, ${parallax.y * 0.1}px, 0)`,
              transition: 'transform 280ms ease-out',
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-45"
            style={{
              backgroundImage:
                'radial-gradient(circle, rgba(163,230,53,0.35) 1px, transparent 1.5px), radial-gradient(circle, rgba(45,212,191,0.24) 1px, transparent 1.5px)',
              backgroundSize: '120px 120px, 160px 160px',
              backgroundPosition: '22px 18px, 74px 44px',
              animation: 'starDriftFast 72s linear infinite',
              transform: `translate3d(${parallax.x * 0.25}px, ${parallax.y * 0.18}px, 0)`,
              transition: 'transform 280ms ease-out',
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-25"
            style={{
              background:
                'repeating-linear-gradient(112deg, rgba(56,189,248,0.08) 0px, rgba(56,189,248,0.08) 1px, transparent 1px, transparent 24px)',
              maskImage: 'radial-gradient(circle at 30% 42%, black 10%, transparent 60%)',
              transform: `translate3d(${parallax.x * 0.35}px, ${parallax.y * 0.25}px, 0)`,
              transition: 'transform 280ms ease-out',
            }}
          />
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute left-4 top-4 h-7 w-7 border-l border-t border-cyan-200/20" />
            <div className="absolute right-4 top-4 h-7 w-7 border-r border-t border-cyan-200/20" />
            <div className="absolute left-4 bottom-4 h-7 w-7 border-l border-b border-cyan-200/20" />
            <div className="absolute right-4 bottom-4 h-7 w-7 border-r border-b border-cyan-200/20" />
            <div className="absolute left-6 top-12 font-mono text-[9px] text-cyan-200/40" style={{ animation: 'hudFloat 5.4s ease-in-out infinite' }}>
              73.402
            </div>
            <div className="absolute right-8 bottom-10 font-mono text-[9px] text-cyan-200/40" style={{ animation: 'hudFloat 6.1s ease-in-out infinite' }}>
              04.119
            </div>
          </div>
          <svg viewBox="0 0 1040 520" className="w-full h-full">
            {Object.values(positions)
              .filter((node) => node.node_type === 'bucket')
              .map((bucket) => {
                const validator = positions[`validator:${bucket.validator_hotkey}`];
                if (!validator) return null;
                return (
                  <path
                    key={`base-${bucket.id}`}
                    d={edgePath(validator, bucket)}
                    fill="none"
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1.5"
                  />
                );
              })}

            {edges.map((edge) => (
              <path
                key={edge.key}
                d={edge.d}
                fill="none"
                stroke={edge.color}
                strokeWidth={edge.width}
                strokeDasharray={edge.dash}
                style={{ animation: 'subnetFlow 14s linear infinite' }}
                opacity={0.95}
              />
            ))}

            {Object.values(positions).map((node) => {
              const isSelected = selectedNode?.id === node.id;
              if (node.node_type === 'owner_api') {
                return (
                  <g key={node.id} onClick={() => setSelectedNodeId(node.id)} className="cursor-pointer">
                    <circle cx={node.x} cy={node.y} r={20} fill="#06101b" stroke="#d1f5ff" strokeWidth="1.6" />
                    <circle cx={node.x} cy={node.y} r={28} fill="none" stroke="rgba(46,225,232,0.18)" strokeDasharray="4 6" />
                    <text x={node.x} y={node.y + 3} textAnchor="middle" fill="#d1f5ff" fontSize="9" fontFamily="JetBrains Mono">API</text>
                    <text x={node.x} y={node.y + 38} textAnchor="middle" fill="#94a3b8" fontSize="9">{node.label}</text>
                  </g>
                );
              }
              if (node.node_type === 'subtensor') {
                return (
                  <g key={node.id} onClick={() => setSelectedNodeId(node.id)} className="cursor-pointer">
                    <rect x={node.x - 24} y={node.y - 16} width={48} height={32} rx={10} fill="#0b1220" stroke="#7dd3fc" strokeWidth="1.4" />
                    <text x={node.x} y={node.y + 3} textAnchor="middle" fill="#d1f5ff" fontSize="8.5" fontFamily="JetBrains Mono">CHAIN</text>
                    <text x={node.x} y={node.y + 36} textAnchor="middle" fill="#94a3b8" fontSize="9">{node.label}</text>
                  </g>
                );
              }
              if (node.node_type === 'validator') {
                const validatorColor = validatorColors[String(node.hotkey)] ?? '#2ee1e8';
                const isEvaluating = node.hotkey ? evaluatingValidators.has(node.hotkey) : false;
                return (
                  <g key={node.id} onClick={() => setSelectedNodeId(node.id)} className="cursor-pointer">
                    {isEvaluating && (
                      <g opacity="0.98">
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={24}
                          fill="none"
                          stroke={`${validatorColor}22`}
                          strokeWidth="2"
                        />
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={24}
                          fill="none"
                          stroke={validatorColor}
                          strokeWidth="2.6"
                          strokeLinecap="round"
                          strokeDasharray="28 124"
                        >
                          <animateTransform
                            attributeName="transform"
                            type="rotate"
                            from={`0 ${node.x} ${node.y}`}
                            to={`360 ${node.x} ${node.y}`}
                            dur="1.15s"
                            repeatCount="indefinite"
                          />
                        </circle>
                      </g>
                    )}
                    <circle cx={node.x} cy={node.y} r={13} fill="#09111c" stroke={isSelected ? '#ffffff' : validatorColor} strokeWidth="1.8" />
                    <circle cx={node.x} cy={node.y} r={19} fill="none" stroke={`${validatorColor}22`} />
                    <text x={node.x} y={node.y + 3} textAnchor="middle" fill="#f8fafc" fontSize="8" fontFamily="JetBrains Mono">{node.label}</text>
                    <text x={node.x} y={node.y + 28} textAnchor="middle" fill="#94a3b8" fontSize="8">{shortHotkey(node.hotkey)}</text>
                  </g>
                );
              }
              if (node.node_type === 'bucket') {
                const validatorColor = validatorColors[String(node.validator_hotkey)] ?? '#94a3b8';
                return (
                  <g key={node.id} onClick={() => setSelectedNodeId(node.id)} className="cursor-pointer">
                    <ellipse cx={node.x} cy={node.y - 5} rx={10} ry={3.5} fill="#0f172a" stroke={`${validatorColor}80`} />
                    <path d={`M ${node.x - 10} ${node.y - 5} L ${node.x - 10} ${node.y + 5} Q ${node.x - 10} ${node.y + 10} ${node.x} ${node.y + 10} Q ${node.x + 10} ${node.y + 10} ${node.x + 10} ${node.y + 5} L ${node.x + 10} ${node.y - 5}`} fill="#0b1220" stroke={`${validatorColor}80`} />
                    <text x={node.x} y={node.y + 20} textAnchor="middle" fill="#94a3b8" fontSize="7.5">{node.label}</text>
                  </g>
                );
              }
              return (
                <g key={node.id} onClick={() => setSelectedNodeId(node.id)} className="cursor-pointer">
                  <circle cx={node.x} cy={node.y} r={11} fill={node.valid ? '#0d1a28' : '#090c12'} stroke={node.valid ? '#2ee1e8' : '#374151'} strokeWidth="1.1" opacity={node.valid ? 1 : 0.55} />
                  <text x={node.x} y={node.y + 3} textAnchor="middle" fill={node.valid ? '#e2e8f0' : '#6b7280'} fontSize="8.5" fontFamily="JetBrains Mono">{node.label}</text>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="border-l border-[#27272a] bg-[#080c14]">
          <div className="border-b border-[#27272a] p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">Selected node</p>
            <h3 className="mt-2 text-base font-semibold text-white">{selectedNode?.label ?? '—'}</h3>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">Type</span>
                <span className="text-white capitalize">{selectedNode?.node_type.replace('_', ' ') ?? '—'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500">Status</span>
                <span className="text-white">{selectedNode ? statusLabel(selectedNode) : '—'}</span>
              </div>
              {selectedNode?.uid != null && (
                <div className="flex justify-between gap-4">
                  <span className="text-gray-500">UID</span>
                  <span className="font-mono text-white">{selectedNode.uid}</span>
                </div>
              )}
              {selectedNode?.hotkey && (
                <div className="flex justify-between gap-4">
                  <span className="text-gray-500">Hotkey</span>
                  <span className="font-mono text-white">{shortHotkey(selectedNode.hotkey)}</span>
                </div>
              )}
              {selectedNode?.bucket_name && (
                <div className="flex justify-between gap-4">
                  <span className="text-gray-500">Bucket</span>
                  <span className="font-mono text-white">{selectedNode.bucket_name}</span>
                </div>
              )}
              {selectedNode?.node_type === 'miner' && selectedNode.valid === false && selectedNode.invalid_reason && (
                <div className="pt-2">
                  <span className="text-gray-500">Invalid reason</span>
                  <p className="mt-1 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                    {selectedNode.invalid_reason}
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">Live event feed</p>
            <div className="mt-4 space-y-3">
              {recentActivities.length === 0 ? (
                <p className="text-sm text-gray-500">No active subnet actions right now.</p>
              ) : (
                recentActivities.map((activity) => (
                  <div
                    key={activity.activity_key}
                    className="rounded-xl border px-3 py-3"
                    style={{ animation: 'eventCardPulse 1.9s ease-in-out infinite' }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: ACTIVITY_COLORS[activity.activity_type] ?? '#e2e8f0' }}>
                        {activity.activity_type.replace(/_/g, ' ')}
                      </span>
                      <span className="text-[10px] text-gray-500">{new Date(activity.started_at).toLocaleTimeString()}</span>
                    </div>
                    <p className="mt-2 font-mono text-xs text-white">{shortHotkey(activity.validator_hotkey)}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
