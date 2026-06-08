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
  // Build element-by-element instructions with full source content
  const elementInstructions = elements.map(el => {
    const sourceVersion = versions.find(v => v.id === el.versionId);
    const sourceContent = sourceVersion
      ? truncateContent(sourceVersion.content, 800)
      : '(source not found)';
    return `## ${el.dimension}
Use from: "${el.versionName}"
Why: ${el.reason}
Excerpt to preserve: "${el.excerpt}"
Full source section:
${sourceContent}`;
  }).join('\n\n---\n\n');

  const language = formState?.language || 'English';
  const tone = formState?.tone || 'Professional';
  const outputType = formState?.outputType || 'marketing copy';

  const systemPrompt = `You are an expert copywriter specializing in ${language} marketing copy. You assemble the best elements from multiple versions into one cohesive, polished final piece.

Your output is ONLY the final copy — no explanations, no labels, no JSON. Just the finished marketing copy ready to use.`;

  const userPrompt = `Assemble a final, cohesive version of this ${outputType} by combining the best elements identified below.

LANGUAGE: ${language}
TONE: ${tone}

BEST ELEMENTS TO COMBINE:

${elementInstructions}

INSTRUCTIONS:
- Use each identified best element as the foundation for its section
- Preserve the key phrases and excerpts identified above
- Ensure smooth transitions between sections so the final piece flows naturally
- Maintain consistent tone throughout (${tone})
- Write in ${language}
- Do NOT add labels or section headers that weren't in the originals unless they improve flow
- The result should feel like one unified piece, not a patchwork

Write the final compiled version now:`;

  const data = await makeApiRequestWithFallback(
    SCORING_MODEL,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    0.4,
    2500
  );

  const content = data.choices?.[0]?.message?.content || '';
  if (!content.trim()) {
    throw new Error('AI returned empty content for compiled version.');
  }

  return content.trim();
}