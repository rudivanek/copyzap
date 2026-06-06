import React from 'react';
import {
  Award, CheckCircle, AlertTriangle, Target,
  RefreshCw, Eye, Clock, Trophy, ChevronDown, ChevronUp
} from 'lucide-react';
import { getScoreTextClass } from '../../../utils/scoreColors';
import { VersionDeepAnalysis, AbsoluteScoreBreakdown } from '../../../types';
import { formatDeltaFromParts, getComparisonDelta } from '../../../utils/comparisonDelta';
import { SubScoreChips } from '../SubScoreChips';
import { calculateMultiScoreDisplay } from '../../../utils/multiScoreDisplay';
import { DecisionBadge, getBadgeStyles, getBestOverallExplanation, getWinnerSummary } from '../../../utils/decisionBadges';
import { WinnerFactors, WinnerBreakdown, DecisionLayer } from '../../../services/api/comprehensiveScoring';
import AbsoluteScoreBadge from '../AbsoluteScoreBadge';

function getAbsoluteScoreColor(total: number): string {
  if (total <= 65) return '#dc2626';
  if (total <= 75) return '#d97706';
  if (total <= 85) return '#16a34a';
  return '#1d4ed8';
}

interface ScoringRow {
  versionId: string;
  optionLabel: string;
  finalScore: number;
  isWinner: boolean;
  insight: string;
  action: string;
  decisionSummary?: string;
  decisionReason?: string;
  subScores?: {
    conversion: number;
    trust: number;
    risk: number;
  };
  verificationFlags?: string[];
}

interface VersionAnalysisCardProps {
  row: ScoringRow;
  analysis?: VersionDeepAnalysis;
  isExpanded: boolean;
  isLoading: boolean;
  isBaseline?: boolean;
  deltaPoints?: number | null;
  deltaPercent?: number | null;
  onToggle: () => void;
  onViewOutput?: () => void;
  onEnsureAnalysis?: () => void;
  contentText?: string;
  decisionBadge?: DecisionBadge | null;
  allVersions?: ScoringRow[];
  winnerExplanation?: string;
  winnerFactors?: WinnerFactors;
  winnerBreakdown?: WinnerBreakdown;
  decisionLayer?: DecisionLayer;
  absoluteScore?: AbsoluteScoreBreakdown;
  baselineAbsTotal?: number | null;
}

interface SectionProps {
  label: string;
  children: React.ReactNode;
  isWinner?: boolean;
}

const Section: React.FC<SectionProps> = ({ label, children, isWinner = false }) => (
  <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-3">
    <span className={`text-[10px] font-bold uppercase tracking-widest ${isWinner ? 'text-green-600' : 'text-gray-400 dark:text-gray-600'}`}>
      {label}
    </span>
    <div className="mt-2.5">{children}</div>
  </div>
);

export const VersionAnalysisCard: React.FC<VersionAnalysisCardProps> = ({
  row,
  analysis,
  isExpanded,
  isLoading,
  isBaseline,
  deltaPoints,
  deltaPercent,
  onToggle,
  onViewOutput,
  onEnsureAnalysis,
  contentText,
  decisionBadge,
  allVersions,
  winnerExplanation,
  winnerFactors,
  winnerBreakdown,
  decisionLayer,
  absoluteScore,
  baselineAbsTotal,
}) => {
  const isMissing = !analysis;
  const hasError = !!analysis?.errorMessage;

  const bestOverallExplanation = !isBaseline && allVersions && allVersions.length > 1
    ? getBestOverallExplanation(row, allVersions)
    : null;

  const winnerSummary = !isBaseline && row.isWinner && allVersions && allVersions.length > 1
    ? getWinnerSummary(row, allVersions)
    : null;

  const showDelta = !isBaseline && deltaPoints != null && deltaPercent != null;
  const delta = showDelta ? formatDeltaFromParts(deltaPoints!, deltaPercent!) : null;

  const deltaBadgeClass = (positive: boolean) =>
    positive
      ? 'text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
      : 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800';

  const absDelta = absoluteScore != null && baselineAbsTotal != null && !isBaseline
    ? getComparisonDelta(absoluteScore.total, baselineAbsTotal)
    : null;

  const isWinner = row.isWinner && !isBaseline;

  // Card border: thicker darker green for winner, thinner lighter green for others
  const cardClass = isBaseline
    ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950'
    : isWinner
    ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950'
    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950';
  // Left border applied via inline style for precise thickness control
  const cardLeftBorderStyle = isBaseline
    ? {}
    : isWinner
    ? { borderLeftWidth: '3px', borderLeftColor: '#22c55e', borderLeftStyle: 'solid' as const }
    : { borderLeftWidth: '1.5px', borderLeftColor: '#86efac', borderLeftStyle: 'solid' as const };

  // Summary line — first visible always
  const summaryLine = isWinner
    ? (winnerExplanation || winnerSummary || bestOverallExplanation || analysis?.summary)
    : analysis?.summary;

  // Sub-scores for always-visible tags (compact)
  const subScores = contentText && contentText.trim().length > 0
    ? calculateMultiScoreDisplay(contentText)
    : null;

  return (
    <div
      id={`breakdown-${row.versionId}`}
      className={`rounded-xl border overflow-hidden transition-shadow ${cardClass}`}
      style={cardLeftBorderStyle}
    >
      <div id={`breakdown-${row.versionId}-output`} />

      {/* Always-visible header — clickable to expand/collapse */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-5 py-4 text-left"
      >
        {/* Title row: name left, score columns right */}
        <div className="flex items-start justify-between gap-4">
          {/* Left: icon + title + badges */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {isWinner && (
                <Award className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
              )}
              <span className={`text-sm ${isWinner ? 'font-extrabold text-gray-900 dark:text-white' : isBaseline ? 'font-semibold text-gray-500 dark:text-gray-400' : 'font-medium text-gray-700 dark:text-gray-300'}`}>
                {isBaseline ? row.optionLabel : (
                  <>
                    <span className="text-gray-400 dark:text-gray-600 font-normal">Analysis of </span>
                    {row.optionLabel}
                  </>
                )}
              </span>
              {isBaseline && (
                <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-600 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-0.5 rounded-full flex-shrink-0">
                  Baseline
                </span>
              )}
              {decisionBadge && !(decisionBadge.type === 'best-overall' && isWinner) && (
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded whitespace-nowrap ${getBadgeStyles(decisionBadge.type)}`}>
                  {decisionBadge.label}
                </span>
              )}
              {isLoading && (
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-gray-400 flex-shrink-0" />
              )}
            </div>
            {/* Summary line */}
            {summaryLine && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                {summaryLine}
              </p>
            )}
            {subScores && (
              <div className="mt-2">
                <SubScoreChips
                  conversion={subScores.conversion}
                  trust={subScores.trust}
                  risk={subScores.risk}
                  compact={true}
                />
              </div>
            )}
          </div>

          {/* Right: score columns + chevron */}
          <div className="flex items-start gap-3 flex-shrink-0">
            <div className="flex items-start gap-5">
              {/* Session column */}
              <div className="flex flex-col items-end gap-1">
                <span className="text-[9px] font-bold text-gray-300 dark:text-gray-700 uppercase tracking-widest">Session</span>
                <span className={`text-xl font-black tabular-nums leading-none ${getScoreTextClass(row.finalScore)}`}>
                  {row.finalScore != null ? row.finalScore : '—'}
                </span>
                {!isBaseline && delta && !delta.neutral ? (
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums whitespace-nowrap ${deltaBadgeClass(delta.positive)}`}>
                    {delta.label}
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-300 dark:text-gray-700">—</span>
                )}
              </div>

              {/* Absolute column */}
              {absoluteScore && (
                <div className="flex flex-col items-end gap-1">
                  <span className="text-[9px] font-bold text-gray-300 dark:text-gray-700 uppercase tracking-widest">Absolute</span>
                  <span className="text-xl font-black tabular-nums leading-none" style={{ color: getAbsoluteScoreColor(absoluteScore.total) }}>
                    {absoluteScore.total}
                  </span>
                  {!isBaseline && absDelta && !absDelta.neutral ? (
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums whitespace-nowrap ${deltaBadgeClass(absDelta.positive)}`}>
                      {absDelta.label}
                    </span>
                  ) : (
                    <span className="text-[10px] text-gray-300 dark:text-gray-700">—</span>
                  )}
                </div>
              )}
            </div>

            {/* Chevron */}
            {isExpanded
              ? <ChevronUp className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-1" />
              : <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-1" />
            }
          </div>
        </div>
      </button>

      {/* Expanded body */}
      {isExpanded && (
        <div className="px-5 pb-5 space-y-0 border-t border-gray-100 dark:border-gray-800">
          {isLoading && !analysis && (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 pt-4">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Generating analysis for {row.optionLabel}...
            </div>
          )}

          {!isLoading && hasError && (
            <div className="flex items-start gap-3 p-3 mt-4 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
              <Clock className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                  Analysis error: {analysis!.errorMessage}
                </p>
                {onEnsureAnalysis && (
                  <button
                    type="button"
                    onClick={onEnsureAnalysis}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    Retry analysis
                  </button>
                )}
              </div>
            </div>
          )}

          {!isLoading && isMissing && !hasError && (
            <div className="flex items-start gap-3 p-3 mt-4 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
              <Clock className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                  Deep analysis not yet generated for this version.
                </p>
                {onEnsureAnalysis && (
                  <button
                    type="button"
                    onClick={onEnsureAnalysis}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Generate Analysis
                  </button>
                )}
              </div>
            </div>
          )}

          {analysis && !hasError && (
            <>
              {/* Why This Wins (winner breakdown) */}
              {isWinner && winnerBreakdown && winnerBreakdown.whatItDoesBetter && winnerBreakdown.whatItDoesBetter.length > 0 && (
                <Section label="Why This Wins" isWinner={true}>
                  <ul className="space-y-1.5">
                    {winnerBreakdown.whatItDoesBetter.map((advantage, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <CheckCircle className="w-3.5 h-3.5 text-green-600 mt-0.5 flex-shrink-0" />
                        <span className="leading-relaxed">{advantage}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {/* Decision / Recommendation */}
              {isWinner && decisionLayer && (
                <Section label="Recommendation" isWinner={true}>
                  <div className="space-y-2.5">
                    {decisionLayer.recommendedLabel && (
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-bold text-gray-400 dark:text-gray-600 uppercase tracking-wider min-w-[72px] flex-shrink-0 pt-0.5">Recommended:</span>
                        <span className="text-xs text-gray-700 dark:text-gray-300 leading-snug font-medium">{decisionLayer.recommendedLabel}</span>
                      </div>
                    )}
                    {decisionLayer.recommendedUseCase && (
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-bold text-gray-400 dark:text-gray-600 uppercase tracking-wider min-w-[72px] flex-shrink-0 pt-0.5">Best for:</span>
                        <span className="text-xs text-gray-700 dark:text-gray-300 leading-snug">{decisionLayer.recommendedUseCase}</span>
                      </div>
                    )}
                    {decisionLayer.publishRecommendation && (
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-bold text-gray-400 dark:text-gray-600 uppercase tracking-wider min-w-[72px] flex-shrink-0 pt-0.5">Use when:</span>
                        <span className="text-xs text-gray-700 dark:text-gray-300 leading-snug">{decisionLayer.publishRecommendation}</span>
                      </div>
                    )}
                    {decisionLayer.alternativeChoiceNote && (
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-bold text-gray-400 dark:text-gray-600 uppercase tracking-wider min-w-[72px] flex-shrink-0 pt-0.5">Alternative:</span>
                        <span className="text-xs text-gray-700 dark:text-gray-300 leading-snug">{decisionLayer.alternativeChoiceNote}</span>
                      </div>
                    )}
                    {decisionLayer.nextImprovementAction && (
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-bold text-gray-400 dark:text-gray-600 uppercase tracking-wider min-w-[72px] flex-shrink-0 pt-0.5">Next step:</span>
                        <span className="text-xs text-gray-700 dark:text-gray-300 leading-snug">{decisionLayer.nextImprovementAction}</span>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* Verification Flags — Claims requiring editor review */}
              {row.verificationFlags && row.verificationFlags.length > 0 && (
                <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-900/40">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-amber-900 dark:text-amber-200 mb-2">
                    Verify before publishing
                  </div>
                  <ul className="space-y-1.5">
                    {row.verificationFlags.map((flag, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                        <span className="flex-shrink-0 mt-0.5">•</span>
                        <span className="leading-snug">{flag}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Key Strengths & Improvements — single column */}
              {((analysis.keyStrengths && analysis.keyStrengths.length > 0) || (analysis.suggestedImprovements && analysis.suggestedImprovements.length > 0)) && (
                <Section label="Key Strengths & Improvements" isWinner={isWinner}>
                  <div className="space-y-4">
                    {analysis.keyStrengths && analysis.keyStrengths.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1.5 mb-2">
                          <CheckCircle className="w-3 h-3 text-green-600 dark:text-green-400" />
                          <span className="text-[10px] font-bold text-gray-400 dark:text-gray-600 uppercase tracking-wider">Key Strengths</span>
                        </div>
                        <ul className="space-y-1.5" id={`breakdown-${row.versionId}-output`}>
                          {analysis.keyStrengths.map((s, idx) => (
                            <li key={idx} className="text-sm text-gray-700 dark:text-gray-300 leading-snug flex items-start gap-1.5">
                              <span className="text-green-500 mt-0.5 flex-shrink-0">•</span>
                              {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.suggestedImprovements && analysis.suggestedImprovements.length > 0 && (() => {
                      // Calculate projected score from suggested improvements
                      const validDeltas = analysis.suggestedImprovements
                        .filter((item: any) => typeof item === 'object' && item.points_delta && item.points_delta > 0)
                        .map((item: any) => item.points_delta);
                      const totalDeltaPoints = validDeltas.reduce((sum: number, delta: number) => sum + delta, 0);
                      const projectedScore = Math.min(92, row.finalScore + totalDeltaPoints);

                      return (
                        <div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <AlertTriangle className="w-3 h-3 text-green-600 dark:text-green-500" />
                            <span className="text-[10px] font-bold text-gray-400 dark:text-gray-600 uppercase tracking-wider">Suggested Improvements</span>
                            {totalDeltaPoints > 0 && (
                              <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 ml-auto">
                                Potential +{totalDeltaPoints} pts (max {projectedScore})
                              </span>
                            )}
                          </div>
                          <ul className="space-y-1.5" id={`breakdown-${row.versionId}-improve`}>
                            {analysis.suggestedImprovements.map((item: any, idx: number) => {
                              const isStructured = typeof item === 'object';
                              const text = isStructured ? item.text : item;
                              const pointsDelta = isStructured ? item.points_delta : null;

                              return (
                                <li key={idx} className="text-sm text-gray-700 dark:text-gray-300 leading-snug flex items-start gap-2">
                                  <span className="text-green-500 mt-0.5 flex-shrink-0">•</span>
                                  <span className="flex-1">{text}</span>
                                  {pointsDelta && pointsDelta > 0 && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800/50 flex-shrink-0 whitespace-nowrap">
                                      +{pointsDelta} pts
                                    </span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })()}
                  </div>
                </Section>
              )}

              {/* Strategic Recommendation */}
              {analysis.strategicRecommendation && (
                <Section label="Strategic Recommendation" isWinner={isWinner}>
                  <div className="flex items-start gap-2">
                    <Target className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                      {analysis.strategicRecommendation}
                    </p>
                  </div>
                </Section>
              )}

              {/* Sub-scores with explanations */}
              {contentText && contentText.trim().length > 0 && (() => {
                const scores = calculateMultiScoreDisplay(contentText);
                return (
                  <Section label="Sub-scores" isWinner={isWinner}>
                    <SubScoreChips
                      conversion={scores.conversion}
                      trust={scores.trust}
                      risk={scores.risk}
                      compact={false}
                      showExplanation={true}
                    />
                  </Section>
                );
              })()}

              {/* Absolute Score breakdown */}
              {absoluteScore && absoluteScore.total > 0 && (
                <Section label="Absolute Score Breakdown" isWinner={false}>
                  <AbsoluteScoreBadge score={absoluteScore} alwaysOpen />
                </Section>
              )}

              {/* Winner Factors */}
              {isWinner && winnerFactors && (
                <Section label="Decision Factors" isWinner={true}>
                  <div className="flex items-start gap-2">
                    <Trophy className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug">
                      {winnerFactors.adjustmentImpact !== 0 && (
                        <>{winnerFactors.adjustmentImpact > 0 ? '+' : ''}{winnerFactors.adjustmentImpact} AI refinement</>
                      )}
                      {winnerFactors.conversionAdvantage !== 0 && (
                        <>{winnerFactors.adjustmentImpact !== 0 && ' • '}{winnerFactors.conversionAdvantage > 0 ? '+' : ''}{winnerFactors.conversionAdvantage.toFixed(1)} conversion vs runner-up</>
                      )}
                      {winnerFactors.trustAdvantage !== 0 && (
                        <>{(winnerFactors.adjustmentImpact !== 0 || winnerFactors.conversionAdvantage !== 0) && ' • '}{winnerFactors.trustAdvantage > 0 ? '+' : ''}{winnerFactors.trustAdvantage.toFixed(1)} trust vs runner-up</>
                      )}
                      {winnerFactors.riskAdvantage !== 'N/A' && winnerFactors.riskAdvantage !== 'same risk' && (
                        <>{(winnerFactors.adjustmentImpact !== 0 || winnerFactors.conversionAdvantage !== 0 || winnerFactors.trustAdvantage !== 0) && ' • '}{winnerFactors.riskAdvantage}</>
                      )}
                    </p>
                  </div>
                </Section>
              )}

              {/* Minor Considerations (tradeoffs for winner, shown collapsed) */}
              {isWinner && winnerBreakdown?.tradeoffs && winnerBreakdown.tradeoffs.length > 0 && (
                <Section label="Minor Considerations" isWinner={false}>
                  <ul className="space-y-1.5">
                    {winnerBreakdown.tradeoffs.map((tradeoff, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                        <span className="leading-relaxed">{tradeoff}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </>
          )}

          {/* View Output Card button */}
          {!isBaseline && onViewOutput && (
            <div className="pt-4">
              <button
                type="button"
                onClick={onViewOutput}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
              >
                <Eye className="w-3.5 h-3.5" />
                View Output Card
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
