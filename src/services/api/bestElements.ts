/**
 * Best Elements Analysis Service
 *
 * Reads all scored versions and identifies the strongest individual section
 * from each version across key copywriting dimensions:
 * headline, hook, testimonials, explanation, CTA, credibility block.
 *
 * This is a user-triggered call (via sidebar button), not automatic.
 * Requires at least 3 versions with a comparison result already present.
 */

import { GeneratedContentItem } from '../../types';
import { makeApiRequestWithFallback, cleanJsonResponse } from './utils';
import { SCORING_MODEL } from '../../constants';
import { ComparisonResult } from './comprehensiveScoring';

export interface BestElement {
  dimension: string;        // e.g. "Headline / Opening Hook"
  versionName: string;      // e.g. "Blended: ..."
  versionId: string;
  excerpt: string;          // Short quote from the winning section (≤ 40 words)
  reason: string;           // One sentence explaining why this element wins
}

export interface BestElementsResult {
  elements: BestElement[];
  assemblyNote: string;     // Short paragraph telling the user how to combine them
  generatedAt: string;
}

function truncateContent(content: any, maxChars = 1200): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

export async function generateBestElements(
  versions: GeneratedContentItem[],
  comparisonResult: ComparisonResult,
  currentUser: any,
  sessionId?: string
): Promise<BestElementsResult> {
  if (versions.length < 2) {
    throw new Error('Need at least 2 versions to identify best elements.');
  }

  // Build a compact summary of each version with its score
  const versionSummaries = versions.map(v => {
    const row = comparisonResult.rows.find((r: any) => r.versionId === v.id);
    const score = row?.finalScore ?? row?.score ?? '—';
    const name = v.sourceDisplayName || v.type || 'Version';
    const content = truncateContent(v.content, 1000);
    return `--- VERSION: "${name}" (Score: ${score}/100) ---\n${content}`;
  }).join('\n\n');

  const systemPrompt = `You are a senior copywriter and content strategist. You analyze multiple versions of marketing copy and identify the single strongest element in each key dimension.

You return ONLY valid JSON — no markdown fences, no explanation text outside the JSON.`;

  const userPrompt = `Analyze these ${versions.length} versions of marketing copy and identify the best individual element across 6 key dimensions.

${versionSummaries}

For each dimension below, identify which version has the strongest execution of that element. Extract a short representative excerpt (max 30 words) and give one concise reason why it wins.

Dimensions to evaluate:
1. Headline / Opening Hook — the first line or headline that grabs attention
2. Problem Statement — how the copy articulates the reader's pain or frustration
3. Treatment Explanation — how clearly and compellingly the solution is explained
4. Social Proof / Testimonials — the testimonial section or trust signals
5. Call to Action — the CTA strength, clarity, and urgency
6. Credibility / Authority — professional credentials and trust-building elements

Return this exact JSON structure:
{
  "elements": [
    {
      "dimension": "Headline / Opening Hook",
      "versionName": "exact version name here",
      "versionId": "exact version id here",
      "excerpt": "short excerpt from that version (max 30 words)",
      "reason": "one sentence explaining why this element wins"
    }
  ],
  "assemblyNote": "2-3 sentence practical note telling the user how to combine these elements into a final version, written in plain language"
}

Return ONLY the JSON. No markdown. No explanation outside the JSON.`;

  const data = await makeApiRequestWithFallback(
    SCORING_MODEL,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    0.3,
    1500
  );

  const raw = data.choices?.[0]?.message?.content || '';
  const cleaned = cleanJsonResponse(raw);

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Failed to parse best elements response from AI.');
  }

  // Attach versionId by matching versionName if AI didn't fill it correctly
  const elements: BestElement[] = (parsed.elements || []).map((el: any) => {
    const matched = versions.find(v =>
      (v.sourceDisplayName || v.type || '').toLowerCase().includes(
        (el.versionName || '').toLowerCase().slice(0, 20)
      )
    );
    return {
      dimension: el.dimension || '—',
      versionName: el.versionName || '—',
      versionId: el.versionId || matched?.id || '',
      excerpt: el.excerpt || '',
      reason: el.reason || '',
    };
  });

  return {
    elements,
    assemblyNote: parsed.assemblyNote || '',
    generatedAt: new Date().toISOString(),
  };
}
/**
 * Compile Best Elements into a new cohesive output version.
 *
 * Takes the identified best elements and the full source versions,
 * and asks the AI to assemble them into one flowing final piece.
 */
export async function compileBestElements(
  elements: BestElement[],
  versions: GeneratedContentItem[],
  formState: any,
  currentUser: any,
  sessionId?: string
): Promise<string> {
  const language = formState?.language || 'English';
  const tone = formState?.tone || 'Professional';
  const outputType = formState?.outputType || 'marketing copy';

  // Find the longest source version to use as length reference
  const longestVersion = versions.reduce((longest, v) => {
    const len = typeof v.content === 'string' ? v.content.length : JSON.stringify(v.content).length;
    const longestLen = typeof longest?.content === 'string' ? longest.content.length : JSON.stringify(longest?.content || '').length;
    return len > longestLen ? v : longest;
  }, versions[0]);
  const referenceLength = typeof longestVersion?.content === 'string'
    ? longestVersion.content.length
    : 800;

  // Build full source versions — NO truncation
  const uniqueVersionIds = [...new Set(elements.map(el => el.versionId).filter(Boolean))];
  const fullVersionContents = uniqueVersionIds.map(vid => {
    const v = versions.find(ver => ver.id === vid);
    if (!v) return '';
    const name = v.sourceDisplayName || v.type || 'Version';
    const content = typeof v.content === 'string' ? v.content : JSON.stringify(v.content);
    return `=== FULL VERSION: "${name}" ===\n${content}`;
  }).filter(Boolean).join('\n\n');

  // Element instructions
  const elementInstructions = elements.map((el, idx) => {
    return `${idx + 1}. ${el.dimension}\n   → Take from: "${el.versionName}"\n   → Key excerpt to preserve: "${el.excerpt}"\n   → Why it wins: ${el.reason}`;
  }).join('\n\n');

  const targetWords = Math.round(referenceLength / 5);

  const systemPrompt = `You are an expert ${language} copywriter. Your job is to compile the best sections from multiple marketing copy versions into one final, complete, production-ready piece.

CRITICAL RULES:
- Do NOT summarize or shorten anything — transplant the actual full sections from the source versions
- The output must be approximately ${targetWords} words (match the longest source version)
- Preserve all specific details: names, phone numbers, addresses, testimonial quotes verbatim, session counts, credentials
- Your output is ONLY the final copy — no explanations, no meta-commentary, no JSON`;

  const userPrompt = `Compile a final ${outputType} in ${language} by transplanting the best section from each source version.

TONE: ${tone}
LANGUAGE: ${language}
TARGET LENGTH: approximately ${targetWords} words — this is a full-length piece, not a summary

BEST ELEMENTS TO USE:

${elementInstructions}

SOURCE VERSIONS (transplant directly from these):

${fullVersionContents}

COMPILATION INSTRUCTIONS:
1. For each of the 6 dimensions above, find that full section in the named source version
2. Transplant it into the compiled output — use the actual text, do not rewrite or shorten
3. Only lightly edit at section boundaries to ensure smooth transitions
4. Keep ALL specific details: testimonials word-for-word, phone numbers, addresses, names, session durations, credentials
5. The final result must be comprehensive and complete — approximately ${targetWords} words
6. Maintain consistent ${tone} tone throughout in ${language}

Write the complete compiled version now:`;

  const data = await makeApiRequestWithFallback(
    SCORING_MODEL,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    0.3,
    4000
  );

  const content = data.choices?.[0]?.message?.content || '';
  if (!content.trim()) {
    throw new Error('AI returned empty content for compiled version.');
  }

  return content.trim();
}