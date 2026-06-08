/**
 * Best Elements Analysis Service
 *
 * Reads all scored versions and identifies the strongest individual section
 * from each version across key copywriting dimensions:
 * headline, hook, testimonials, explanation, CTA, credibility block.
 *
 * Compile strategy: CODE-LEVEL EXTRACTION, not AI rewriting.
 * The AI only identifies which excerpt belongs to which section.
 * The code extracts the actual text blocks from source versions.
 * A small AI call writes only the transition sentences between blocks.
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
  assemblyNote: string;
  generatedAt: string;
}

function truncateContent(content: any, maxChars = 1200): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

/**
 * Split content into sections by double newline or markdown heading.
 * Returns an array of blocks (each block is a heading + its paragraphs).
 */
function splitIntoSections(content: string): string[] {
  if (!content) return [];

  // Split on markdown headings (# ## ###) or double newlines
  const lines = content.split('\n');
  const sections: string[] = [];
  let currentSection: string[] = [];

  for (const line of lines) {
    const isHeading = /^#{1,3}\s/.test(line.trim());
    if (isHeading && currentSection.length > 0) {
      const block = currentSection.join('\n').trim();
      if (block) sections.push(block);
      currentSection = [line];
    } else {
      currentSection.push(line);
    }
  }

  // Push last section
  if (currentSection.length > 0) {
    const block = currentSection.join('\n').trim();
    if (block) sections.push(block);
  }

  // If no headings found, split by double newline paragraphs
  if (sections.length <= 1) {
    return content
      .split(/\n\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 20);
  }

  return sections;
}

/**
 * Find the section in a version's content that best matches an excerpt.
 * Returns the full section text, or the excerpt itself if no match found.
 */
function extractMatchingSection(content: string, excerpt: string): string {
  if (!content || !excerpt) return excerpt || '';

  const sections = splitIntoSections(content);
  if (sections.length === 0) return excerpt;

  // Normalize for comparison
  const normalizedExcerpt = excerpt.toLowerCase().replace(/[""«»]/g, '"').trim();

  // Try exact substring match first
  for (const section of sections) {
    const normalizedSection = section.toLowerCase().replace(/[""«»]/g, '"');
    // Check if excerpt words appear in this section
    const excerptWords = normalizedExcerpt
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 5); // first 5 meaningful words
    const matchCount = excerptWords.filter(w => normalizedSection.includes(w)).length;
    if (matchCount >= Math.min(3, excerptWords.length)) {
      return section;
    }
  }

  // Fallback: return the largest section (most content)
  return sections.reduce((longest, s) => s.length > longest.length ? s : longest, sections[0]);
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
    return `--- VERSION: "${name}" (Score: ${score}/100) id:${v.id} ---\n${content}`;
  }).join('\n\n');

  const systemPrompt = `You are a senior copywriter and content strategist. You analyze multiple versions of marketing copy and identify the single strongest element in each key dimension.

You return ONLY valid JSON — no markdown fences, no explanation text outside the JSON.`;

  const userPrompt = `Analyze these ${versions.length} versions of marketing copy and identify the best individual element across 6 key dimensions.

${versionSummaries}

For each dimension below, identify which version has the strongest execution of that element.
Extract a short representative excerpt (max 30 words) — this MUST be the actual text from that version, word for word.
Give one concise reason why it wins.
Include the exact versionId from the "id:" tag shown above.

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
      "versionId": "exact versionId from the id: tag",
      "excerpt": "actual verbatim text from that version (max 30 words)",
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
    // First try direct ID match
    let matched = versions.find(v => v.id === el.versionId);
    // Fallback: match by name
    if (!matched) {
      matched = versions.find(v =>
        (v.sourceDisplayName || v.type || '').toLowerCase().includes(
          (el.versionName || '').toLowerCase().slice(0, 20)
        )
      );
    }
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
 * Compile Best Elements — CODE-LEVEL EXTRACTION approach.
 *
 * Step 1: For each element, find the matching section in the source version using
 *         text matching (no AI rewriting).
 * Step 2: Concatenate the extracted blocks in order.
 * Step 3: One small AI call to write smooth 1-sentence transitions between blocks.
 *
 * The AI never touches the actual copy content — only writes transitions.
 * This guarantees headings, phone numbers, testimonials, and all details are preserved.
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

  // ── STEP 1: Extract the actual section from each source version ──────────────
  const extractedBlocks: Array<{ dimension: string; block: string; versionName: string }> = [];

  for (const el of elements) {
    const sourceVersion = versions.find(v => v.id === el.versionId);
    if (!sourceVersion) continue;

    const content = typeof sourceVersion.content === 'string'
      ? sourceVersion.content
      : JSON.stringify(sourceVersion.content);

    const extractedSection = extractMatchingSection(content, el.excerpt);
    extractedBlocks.push({
      dimension: el.dimension,
      block: extractedSection,
      versionName: el.versionName,
    });
  }

  if (extractedBlocks.length === 0) {
    throw new Error('Could not extract any sections from source versions.');
  }

  // ── STEP 2: Concatenate blocks with placeholder transitions ──────────────────
  // We'll ask the AI to only generate the transition text, not rewrite anything
  const blocksForAI = extractedBlocks.map((b, idx) => ({
    index: idx,
    dimension: b.dimension,
    content: b.block,
  }));

  const systemPrompt = `You are an expert ${language} copywriter. You receive a list of extracted copy sections that must appear VERBATIM in the final output.

Your ONLY job is to write a SHORT transition sentence (max 15 words) between each pair of sections where needed.
You must NEVER rewrite, summarize, or alter the provided sections.
Return ONLY valid JSON.`;

  const userPrompt = `These are ${blocksForAI.length} extracted sections that will be assembled in order. Write a brief transition sentence (max 15 words, in ${language}) to place BETWEEN each consecutive pair where the topic shift is abrupt. If two sections flow naturally, return an empty string for that transition.

Sections:
${blocksForAI.map(b => `[${b.index}] ${b.dimension}:\n${b.content.slice(0, 200)}…`).join('\n\n')}

Return this JSON:
{
  "transitions": ["transition after block 0", "transition after block 1", "transition after block 2", "transition after block 3", "transition after block 4"]
}

Transitions must be in ${language}, tone: ${tone}. Use empty string "" if no transition needed.
Return ONLY JSON.`;

  let transitions: string[] = new Array(extractedBlocks.length - 1).fill('');

  try {
    const data = await makeApiRequestWithFallback(
      SCORING_MODEL,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      0.3,
      500
    );
    const raw = data.choices?.[0]?.message?.content || '';
    const cleaned = cleanJsonResponse(raw);
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed.transitions)) {
      transitions = parsed.transitions;
    }
  } catch {
    // Non-critical — proceed without transitions
  }

  // ── STEP 3: Assemble the final compiled text ─────────────────────────────────
  const parts: string[] = [];
  for (let i = 0; i < extractedBlocks.length; i++) {
    parts.push(extractedBlocks[i].block);
    if (i < extractedBlocks.length - 1 && transitions[i]?.trim()) {
      parts.push(transitions[i].trim());
    }
  }

  return parts.join('\n\n');
}