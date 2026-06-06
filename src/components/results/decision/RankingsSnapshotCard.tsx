import React, { useMemo } from 'react';
import { Info } from 'lucide-react';
import { getComparisonDelta } from '../../../utils/comparisonDelta';
import { calculateMultiScoreDisplay } from '../../../utils/multiScoreDisplay';
import { getDecisionBadgeForVersion, getBadgeStyles, DecisionBadge } from '../../../utils/decisionBadges';
import { SubScoreChips } from '../SubScoreChips';
import { formatLocalDateTime } from '../../../utils/dateFormatting';
import { AbsoluteScoreBreakdown } from '../../../types';

function getAbsoluteScoreColor(total: number): string {
  if (total <= 65) return '#dc2626';
  if (total <= 75) return '#d97706';
  if (total <= 85) return '#16a34a';
  return '#1d4ed8';
}

interface RankRow {
  versionId: string;
  optionLabel: string;
  finalScore: number;
  deltaVsBest: number;
  improvementPct?: number | null;
  isWinner: boolean;
  evaluatedAt?: string;
  contentText?: string;
  absoluteScore?: AbsoluteScoreBreakdown;
  // Diagnostic: new positioning-aware subscores (optional)
  humanAuthenticity?: number;
  overMarketingPenalty?: number;
  brandFit?: number;
  // Verification flags for editor review
  verificationFlags?: string[];
}

interface RankingsSnapshotCardProps {
  rows: RankRow[];
  baselineVersionId?: string;
  baselineScore?: number | null;
  hasBaseline?: boolean;
  latestEvaluatedAt?: number | null;
  onRowClick?: (versionId: string) => void;
}

function getAbsoluteDelta(rowTotal: number, baselineTotal: number): { label: string; positive: boolean; negative: boolean } | null {
  const diff = rowTotal - baselineTotal;
  if (diff === 0) return null;
  const pct = baselineTotal > 0 ? ((diff / baselineTotal) * 100).toFixed(1) : '0.0';
  const sign = diff > 0 ? '+' : '';
  return {
    label: `${sign}${diff} pts (${sign}${pct}%)`,
    positive: diff > 0,
    negative: diff < 0,
  };
}

const ScoreColumnLabel: React.FC<{ label: string; tip: string }> = ({ label, tip }) => {
  const [show, setShow] = React.useState(false);
  return (
    <span className="relative inline-flex items-center gap-0.5 cursor-default"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span className="text-[9px] font-bold text-gray-300 dark:text-gray-700 uppercase tracking-widest">{label}</span>
      <Info size={9} className="text-gray-200 dark:text-gray-800" />
      {show && (
        <span className="absolute bottom-full right-0 mb-1.5 z-50 w-44 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-[10px] leading-snug rounded px-2 py-1.5 shadow-lg pointer-events-none whitespace-normal text-center">
          {tip}
        </span>
      )}
    </span>
  );
};

export const RankingsSnapshotCard: React.FC<RankingsSnapshotCardProps> = ({
  rows,
  baselineVersionId,
  baselineScore,
  onRowClick,
}) => {
  const decisionBadges = useMemo(() => {
    const versionsWithScores = rows.map(row => {
      const subScores = row.contentText ? calculateMultiScoreDisplay(row.contentText) : null;
      return {
        versionId: row.versionId,
        finalScore: row.finalScore,
        subScores: subScores ? {
          conversion: subScores.conversion,
          trust: subScores.trust,
          risk: subScores.risk
        } : undefined
      };
    });

    const badgeMap = new Map<string, DecisionBadge | null>();
    versionsWithScores.forEach(version => {
      const badge = getDecisionBadgeForVersion(version, versionsWithScores);
      badgeMap.set(version.versionId, badge);
    });

    return badgeMap;
  }, [rows]);

  const baselineRow = rows.find(r => r.versionId === baselineVersionId)
    ?? rows.find(r => r.optionLabel === 'Original Copy')
    ?? null;
  const baselineAbsTotal = baselineRow?.absoluteScore?.total ?? null;

  return (
    <div id="results-rankings" className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
        <span className="text-[10px] font-bold text-gray-300 dark:text-gray-700 uppercase tracking-widest">
          Rankings
        </span>
        <div className="flex items-center gap-3">
          <ScoreColumnLabel label="Session" tip="Relative to other versions generated in this session" />
          <ScoreColumnLabel label="Absolute" tip="Evaluated in isolation — does not change as new versions are added" />
        </div>
      </div>
      <div className="divide-y divide-gray-50 dark:divide-gray-900">
        {rows.map((row, idx) => {
          const isBaseline = row.versionId === baselineVersionId;
          const delta = isBaseline ? null : getComparisonDelta(row.finalScore, baselineScore);
          const deltaBadgeClass = delta
            ? delta.positive
              ? 'text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
              : delta.negative
              ? 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
              : 'text-gray-500 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
            : '';
          const absDelta = (!isBaseline && row.absoluteScore && baselineAbsTotal !== null)
            ? getAbsoluteDelta(row.absoluteScore.total, baselineAbsTotal)
            : null;
          const absDeltaClass = absDelta
            ? absDelta.positive
              ? 'text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
              : 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
            : '';

          const subScores = row.contentText ? calculateMultiScoreDisplay(row.contentText) : null;
          const decisionBadge = decisionBadges.get(row.versionId);
          const shouldShowBadge = decisionBadge && !(decisionBadge.type === 'best-overall' && row.isWinner);

          return (
            <div
              key={row.versionId}
              onClick={() => !isBaseline && onRowClick?.(row.versionId)}
              className={[
                'flex items-center gap-3 py-3 transition-colors',
                row.isWinner
                  ? 'border-l-2 border-l-green-600 pl-3 pr-4'
                  : 'px-4',
                !isBaseline && !row.isWinner ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/50' : '',
                !row.isWinner ? 'opacity-80' : '',
              ].join(' ')}
            >
              {/* Rank number */}
              <span className="text-[10px] tabular-nums w-4 flex-shrink-0 text-gray-300 dark:text-gray-700 font-bold">
                {idx + 1}
              </span>

              {/* Name + tags */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                  <span className={`text-sm truncate ${row.isWinner ? 'font-bold text-gray-900 dark:text-white' : 'font-normal text-gray-500 dark:text-gray-500'}`}>
                    {row.optionLabel}
                  </span>
                  {isBaseline && (
                    <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-600 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                      Baseline
                    </span>
                  )}
                  {shouldShowBadge && decisionBadge && (
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${getBadgeStyles(decisionBadge.type)}`}>
                      {decisionBadge.label}
                    </span>
                  )}
                </div>
                {row.evaluatedAt && (
                  <div className="text-[10px] text-gray-400 dark:text-gray-600">
                    {formatLocalDateTime(row.evaluatedAt)}
                  </div>
                )}
                {subScores && (
                  <div className="mt-1">
                    <SubScoreChips
                      conversion={subScores.conversion}
                      trust={subScores.trust}
                      risk={subScores.risk}
                      compact={true}
                    />
                  </div>
                )}
              </div>

              {/* Session Score + delta */}
              <div className="flex items-center gap-2 flex-shrink-0">
                {delta && !delta.neutral && (
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums ${deltaBadgeClass}`}>
                    {delta.label}
                  </span>
                )}
                <span className={`text-sm tabular-nums w-7 text-right ${row.isWinner ? 'font-black text-gray-900 dark:text-white' : 'font-bold text-gray-400 dark:text-gray-500'}`}>
                  {row.finalScore}
                </span>
                {/* Absolute Score + delta */}
                <div className="flex items-center gap-1.5">
                  {absDelta && (
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums ${absDeltaClass}`}>
                      {absDelta.label}
                    </span>
                  )}
                  <span
                    className={`text-sm tabular-nums w-7 text-right ${row.absoluteScore ? (row.isWinner ? 'font-bold' : 'font-semibold') : 'text-gray-200 dark:text-gray-800'}`}
                    style={row.absoluteScore ? { color: getAbsoluteScoreColor(row.absoluteScore.total) } : undefined}
                  >
                    {row.absoluteScore ? row.absoluteScore.total : '—'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: '12px', color: '#9ca3af', fontStyle: 'italic', marginTop: '12px', padding: '0 4px' }}>
        &#9432; Session scores are relative to other versions in this session — adding new versions may slightly adjust them. Absolute scores are evaluated in isolation and never change. Focus on the Absolute score for a stable quality benchmark.
      </p>
    </div>
  );
};
