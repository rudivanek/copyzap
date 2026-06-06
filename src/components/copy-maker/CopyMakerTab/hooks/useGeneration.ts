import { useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { v4 as uuidv4 } from 'uuid';
import { FormState, User, GeneratedContentItem, GeneratedContentItemType, CopyResult, ScoringContext, MAX_BOOST_ITERATIONS, MAX_BOOST_SCORE_THRESHOLD } from '../../../../types';
import {
  generateCopy,
  generateContentScores,
  generateSeoMetadata,
  calculateGeoScore,
  generateAlternativeCopy,
  restyleCopyWithPersona
} from '../../../../services/apiService';
import { generateUnifiedComparison } from '../../../../services/api/unifiedComparison';
import { repairDecisionLayerFields as _repairDecisionLayerFields } from '../../../../services/api/comprehensiveScoring';
import { generateAbsoluteScore } from '../../../../services/api/absoluteScoring';
import { checkUserAccess, getSupabaseClient, saveAbsoluteScore } from '../../../../services/supabaseClient';
import { calculateTargetWordCount, extractWordCount } from '../../../../services/api/utils';
import { isContentEmpty } from '../utils/isContentEmpty';
import { sessionManager } from '../../../../services/sessionService';
import { useSession } from '../../../../context/SessionContext';
import { WorkflowService } from '../../../../services/workflowService';
import { WorkflowExecutionEngine } from '../../../../services/workflowExecutionEngine';
import { playSuccessSound } from '../../../../utils/soundEffects';
import { isSessionCreationError, SessionCreationError } from '../../../../utils/sessionErrors';
import { debugCompare } from '../../../../utils/debugLogger';
import { triggerGuidanceHint } from '../../../../utils/guidanceHintService';

export const ORIGINAL_VERSION_ID = '__original__';

/**
 * Parse a keywords string (comma or newline or semicolon separated) into a clean array.
 * Deduplicates and filters empty entries.
 */
function parseKeywordsString(raw?: string): string[] {
  if (!raw || raw.trim() === '') return [];
  return [...new Set(
    raw.split(/[\n,;]+/)
      .map(k => k.trim())
      .filter(k => k.length > 0)
  )];
}

function ensureOriginalVersion(
  versions: GeneratedContentItem[],
  originalCopy: string | undefined
): GeneratedContentItem[] {
  if (!originalCopy?.trim()) return versions;
  if (versions.some(v => v.type === GeneratedContentItemType.Original)) return versions;
  const syntheticOriginal: GeneratedContentItem = {
    id: ORIGINAL_VERSION_ID,
    type: GeneratedContentItemType.Original,
    content: originalCopy.trim(),
    generatedAt: new Date().toISOString(),
    sourceDisplayName: 'Original Copy',
    analysisMode: 'batch'
  };
  return [syntheticOriginal, ...versions];
}

interface UseGenerationReturn {
  handleGenerate: () => void;
  handleOnDemandGeneration: (actionType: string, sourceItem: GeneratedContentItem, persona?: string, instructions?: string) => void;
  handleModifyContent: (sourceItem: GeneratedContentItem, instruction: string) => void;
  handlePerformanceBoost: (sourceItem: GeneratedContentItem) => Promise<void>;
  handleGenerateFaqSchema: (content: string) => void;
  handleCancelOperation: () => void;
  compareOutputsWithGrok: (isIncremental?: boolean, scoringContext?: import('../../../../types').ScoringContext) => void;
  reanalyzeAllDeep: () => void;
  generateDetailedAnalysis: () => void;
  ensureVersionDeepAnalysis: (versionId: string, freshComparisonResult?: any) => Promise<void>;
  isGeneratingDetails: boolean;
  loadingVersionIds: Set<string>;
  isComparing: boolean;
}

/**
 * Run deep analysis for all versions after comparison
 * Uses caching to avoid re-analyzing unchanged versions
 */
async function runDeepAnalysisForAll(
  versions: GeneratedContentItem[],
  comparisonResult: any,
  formState: FormState,
  currentUser: any,
  sessionId: string,
  progressCallback?: (message: string) => void
): Promise<{ versionAnalyses: Record<string, any>; meta: any }> {
  const { analyzeVersionDeep, generateOverallVerdict, isDeepAnalysisCacheValid } = await import('../../../../services/api/versionDeepAnalysis');

  const versionAnalyses: Record<string, any> = {};
  const existingCache = formState.copyResult?.versionDeepAnalysis || {};

  // Get winner info from comparison result
  const winnerRow = comparisonResult.rows.find((r: any) => r.isWinner);
  if (!winnerRow) {
    throw new Error('No winner found in comparison result');
  }

  const winnerVersion = versions.find(v => v.id === winnerRow.versionId);
  if (!winnerVersion) {
    throw new Error('Winner version not found');
  }

  // Analyze each version (with caching)
  for (const version of versions) {
    const optionLabel = version.sourceDisplayName || version.type || 'Version';

    // Check cache — skip if already analyzed
    const cachedAnalysis = existingCache[version.id];
    if (cachedAnalysis) {
      versionAnalyses[version.id] = cachedAnalysis;
      continue;
    }

    try {
      progressCallback?.(`Analyzing ${optionLabel}...`);

      // Resolve this version's LLM score and its parent's score for delta calibration.
      // Row lookup uses the comparison result; fall back to the version's own score.overall
      // (set during generation) when the version was added after the last comparison run.
      const thisRow = comparisonResult.rows.find((r: any) => r.versionId === version.id);
      const currentScore: number | undefined =
        thisRow?.score ?? thisRow?.finalScore ??
        (typeof version.score?.overall === 'number' ? version.score.overall : undefined);
      const parentVersion = version.sourceId
        ? versions.find(v => v.id === version.sourceId)
        : undefined;
      const parentRow = parentVersion
        ? comparisonResult.rows.find((r: any) => r.versionId === parentVersion.id)
        : undefined;
      const parentScore: number | undefined =
        parentRow?.score ?? parentRow?.finalScore ??
        (typeof parentVersion?.score?.overall === 'number' ? parentVersion.score!.overall : undefined);
      const parentCopyText: string | undefined = parentVersion
        ? (typeof parentVersion.content === 'string'
            ? parentVersion.content
            : JSON.stringify(parentVersion.content))
        : undefined;

      const analysis = await analyzeVersionDeep(
        version.content,
        optionLabel,
        formState.model,
        currentUser,
        formState,
        sessionId,
        progressCallback,
        currentScore,
        parentScore,
        parentCopyText
      );

      analysis.versionId = version.id;
      versionAnalyses[version.id] = analysis;
    } catch (error) {
      console.error(`Failed to analyze ${optionLabel}:`, error);
      // Continue with other versions
    }
  }

  // Generate overall verdict
  progressCallback?.('Generating overall verdict...');
  const meta = await generateOverallVerdict(
    winnerRow.versionId,
    winnerRow.optionLabel,
    winnerVersion.content,
    versionAnalyses,
    formState.model,
    currentUser,
    formState,
    sessionId
  );

  return {
    versionAnalyses,
    meta
  };
}

export function useGeneration(
  currentUser?: User,
  formState?: FormState,
  setFormState?: (state: FormState | ((prev: FormState) => FormState)) => void,
  addProgressMessage?: (message: string) => void,
  onAccessDenied?: () => void,
  onNewOutputAdded?: (newOutputCount: number) => void
): UseGenerationReturn {
  const projectDescriptionRef = useRef<HTMLInputElement>(null);
  const originalCopyRef = useRef<HTMLTextAreaElement>(null);
  const formStateRef = useRef<FormState | null>(formState);
  formStateRef.current = formState;
  const { setCurrentSession, ensureActiveSession } = useSession();
  const [isGeneratingDetails, setIsGeneratingDetails] = useState(false);
  const [loadingVersionIds, setLoadingVersionIds] = useState<Set<string>>(new Set());
  const [isComparing, setIsComparing] = useState(false);

  // Helper function to fetch brand voice name
  const getBrandVoiceName = async (brandVoiceId?: string): Promise<string | undefined> => {
    if (!brandVoiceId) return undefined;

    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('pmc_public_brand_voices')
        .select('name')
        .eq('id', brandVoiceId)
        .maybeSingle();

      if (error) {
        console.error('Error fetching brand voice name:', error);
        return undefined;
      }

      return data?.name;
    } catch (err) {
      console.error('Exception fetching brand voice name:', err);
      return undefined;
    }
  };

  // Handle initial copy generation
  const handleGenerate = async () => {
    if (!formState || !setFormState || !addProgressMessage) return;

    // Create working copy of formState that we can modify
    let workingFormState = { ...formState };

    // Validate that all required fields are populated
    const hasProjectDescription = workingFormState.projectDescription?.trim();
    const hasProductServiceName = workingFormState.productServiceName?.trim();

    // Check mode-specific content field
    const hasRequiredContent = workingFormState.tab === 'improve'
      ? workingFormState.originalCopy?.trim()
      : workingFormState.businessDescription?.trim();

    // Validate all three required fields
    if (!hasProjectDescription) {
      toast.error('Please provide a Project Description for session tracking.');
      return;
    }

    if (!hasProductServiceName) {
      toast.error('Please provide a Product/Service Name.');
      return;
    }

    if (!hasRequiredContent) {
      const missingField = workingFormState.tab === 'improve' ? 'Original Copy' : 'Business Description';
      toast.error(`Please provide ${missingField}.`);
      return;
    }

    if (!currentUser) {
      toast.error('Please log in to generate copy.');
      return;
    }

    // Check user access before generation
    try {
      const accessResult = await checkUserAccess(currentUser.id, currentUser.email || '');

      if (!accessResult.hasAccess) {
        if (onAccessDenied) {
          onAccessDenied();
        } else {
          toast.error(accessResult.message);
        }
        return;
      }
    } catch (error) {
      console.error('Error checking user access for generation:', error);
      toast.error("Unable to verify access. Please try again.");
      return;
    }

    setFormState(prev => ({
      ...prev,
      isLoading: true,
      generationProgress: [],
      copyResult: {
        ...prev.copyResult,
        generatedVersions: [] // Clear previous results
      }
    }));
    addProgressMessage('Starting copy generation...');

    // Ensure we have a session ID (create one if needed)
    let actualSessionId = workingFormState.sessionId;

    if (!actualSessionId) {
      console.log('📝 No saved session - creating one for generation tracking');
      try {
        actualSessionId = await ensureActiveSession(
          currentUser.id,
          workingFormState.outputType,
          workingFormState.projectDescription,
          workingFormState.customerId,
          workingFormState
        );
        console.log('✅ Created session for generation:', actualSessionId);

        // Update the working state with the new session ID
        workingFormState = { ...workingFormState, sessionId: actualSessionId };

        // Update formState with new session ID
        setFormState(prev => ({
          ...prev,
          sessionId: actualSessionId
        }));
      } catch (error: any) {
        console.error('❌ Failed to create session for generation:', error);
        toast.error('Failed to create tracking session. Please retry.');
        setFormState(prev => ({ ...prev, isLoading: false }));
        return;
      }
    } else {
      console.log('📝 Using existing session:', actualSessionId);
    }

    try {
      // Fetch brand voice name if brandVoiceId is set
      const brandVoiceName = await getBrandVoiceName(workingFormState.brandVoiceId);

      // Always use enhanced (CopyZap+) mode
      const enhancedFormState = { ...workingFormState, aiEngineMode: 'enhanced' as const };

      // DETERMINE ANALYSIS MODE based on toggle state at generation time
      const isBatchMode =
        enhancedFormState.generateSeoMetadata === true ||
        enhancedFormState.generateScores === true ||
        enhancedFormState.generateGeoScore === true;

      const analysisMode: 'batch' | 'on_demand' = isBatchMode ? 'batch' : 'on_demand';

      console.log(`📊 Analysis Mode: ${analysisMode} (SEO: ${enhancedFormState.generateSeoMetadata}, Score: ${enhancedFormState.generateScores}, GEO: ${enhancedFormState.generateGeoScore})`);

      let generatedVersions: GeneratedContentItem[] = [];
      let result: CopyResult | null = null; // For backward compatibility

      // Check if we should generate multiple variants
      const shouldCreateVariants = enhancedFormState.createVariants && enhancedFormState.numberOfVariants && enhancedFormState.numberOfVariants > 1;
      const variantCount = shouldCreateVariants ? enhancedFormState.numberOfVariants! : 1;

      // Generate score for original copy if in improve mode (do this once before variants)
      let originalCopyItem: GeneratedContentItem | undefined;
      if (enhancedFormState.generateScores && enhancedFormState.tab === 'improve' && enhancedFormState.originalCopy) {
        addProgressMessage('Generating score for original copy...');
        const originalScore = await generateContentScores(
          enhancedFormState.originalCopy,
          'Original Copy',
          enhancedFormState.model,
          currentUser,
          enhancedFormState.businessDescription,
          calculateTargetWordCount(enhancedFormState).target,
          actualSessionId,
          addProgressMessage
        );
        originalCopyItem = {
          id: uuidv4(),
          type: GeneratedContentItemType.Original,
          content: enhancedFormState.originalCopy,
          generatedAt: new Date().toISOString(),
          sourceDisplayName: 'Original Copy',
          score: originalScore,
          brandVoiceName,
          analysisMode // Set the analysis mode
        };
        addProgressMessage('Original copy score generated.');
      }

      // Generate variants
      const variantItems: GeneratedContentItem[] = [];
      for (let i = 1; i <= variantCount; i++) {
        if (shouldCreateVariants) {
          addProgressMessage(`Generating variant ${i} of ${variantCount}...`);
        }

        result = await generateCopy(enhancedFormState, currentUser, actualSessionId, addProgressMessage);

        // Check for validation failure (LIGHT validation layer)
        if (result && result.validationFailed) {
          console.error('❌ Copy Maker output validation failed:', result.validationErrors);

          // Set error state with validation info
          setFormState(prev => ({
            ...prev,
            isLoading: false,
            validationFailed: true,
            validationErrors: result.validationErrors,
            rawFailedOutput: result.rawFailedOutput
          }));

          addProgressMessage('❌ Output validation failed. Retry attempt unsuccessful.');

          toast.error(
            'Generated output failed validation. Please check the warning banner for options.',
            { duration: 6000 }
          );

          return; // Stop generation process
        }

        // Validate result
        if (!result || !result.improvedCopy) {
          throw new Error(`Failed to generate content for variant ${i}`);
        }

        const improvedCopyItem: GeneratedContentItem = {
          id: uuidv4(),
          type: GeneratedContentItemType.Improved,
          content: result.improvedCopy,
          sourceText: enhancedFormState.tab === 'improve'
            ? enhancedFormState.originalCopy
            : enhancedFormState.businessDescription, // Store source text for evidence analysis
          generatedAt: new Date().toISOString(),
          sourceDisplayName: shouldCreateVariants ? `Generated Copy ${i}` : 'Generated Copy 1',
          brandVoiceName,
          analysisMode // Set the analysis mode
        };

        // Add GEO score if it was generated
        if (result.geoScore) {
          improvedCopyItem.geoScore = result.geoScore;
        }

        // Add SEO metadata if it was generated
        if (result.seoMetadata) {
          improvedCopyItem.seoMetadata = result.seoMetadata;
        }

        // Add FAQ schema if it was generated
        if (result.faqSchema) {
          improvedCopyItem.faqSchema = result.faqSchema;
        }

        // Generate score for improved copy if enabled
        if (enhancedFormState.generateScores) {
          addProgressMessage(`Generating score for variant ${i}...`);
          const score = await generateContentScores(
            result.improvedCopy,
            improvedCopyItem.sourceDisplayName || 'Generated Copy',
            enhancedFormState.model,
            currentUser,
            enhancedFormState.tab === 'improve' ? enhancedFormState.originalCopy : enhancedFormState.businessDescription,
            calculateTargetWordCount(enhancedFormState).target,
            actualSessionId,
            addProgressMessage
          );
          improvedCopyItem.score = score;
          addProgressMessage(`Score generated for variant ${i}.`);
        }

        // Always generate absolute score (independent of session scoring toggle)
        try {
          const absScore = await generateAbsoluteScore(result.improvedCopy, currentUser, actualSessionId);
          improvedCopyItem.absoluteScore = absScore;
          if (currentUser?.id) {
            saveAbsoluteScore(currentUser.id, improvedCopyItem.id, absScore, actualSessionId);
          }
        } catch {
          // non-critical — proceed without absolute score
        }

        variantItems.push(improvedCopyItem);
      }

      // Set generatedVersions
      generatedVersions = originalCopyItem
        ? [originalCopyItem, ...variantItems]
        : variantItems;

      // Track if we should trigger comparison after workflow
      let shouldTriggerComparison = false;
      let workflowScoringContext: import('../../../../types').ScoringContext | undefined;

      // Execute workflow if selected
      if (enhancedFormState.workflowId) {
        try {
          addProgressMessage('Loading workflow...');
          const workflow = await WorkflowService.getWorkflowById(enhancedFormState.workflowId);

          if (workflow && workflow.steps && workflow.steps.length > 0) {
            addProgressMessage(`Executing workflow: ${workflow.name}`);

            // Get the first generated copy as the base for workflow execution
            const baseContent = result?.improvedCopy || '';

            if (baseContent) {
              // Create workflow execution engine
              const engine = new WorkflowExecutionEngine(
                workflow,
                baseContent,
                enhancedFormState,
                currentUser,
                (message, currentStep, totalSteps) => {
                  addProgressMessage(`[Workflow ${currentStep}/${totalSteps}] ${message}`);
                }
              );

              // Execute workflow
              const workflowResult = await engine.execute();

              if (workflowResult.success && workflowResult.generatedOutputs) {
                // Add workflow-generated outputs to the generated versions
                generatedVersions = [...generatedVersions, ...workflowResult.generatedOutputs];
                addProgressMessage(`Workflow complete! Generated ${workflowResult.generatedOutputs.length} additional outputs.`);

                // Store the flag to trigger comparison later (always uses comprehensive analysis)
                shouldTriggerComparison = workflowResult.shouldTriggerComparison || false;
                workflowScoringContext = workflowResult.scoringContext;
              } else if (workflowResult.error) {
                addProgressMessage(`Workflow error: ${workflowResult.error}`);
                toast.error(`Workflow partially failed: ${workflowResult.error}`);
              }
            }
          } else {
            addProgressMessage('Workflow not found or has no steps.');
          }
        } catch (workflowError: any) {
          console.error('Error executing workflow:', workflowError);
          addProgressMessage(`Workflow execution error: ${workflowError.message}`);
          toast.error(`Workflow failed: ${workflowError.message}`);
        }
      }

      // Determine improvedCopy for backward compatibility
      const improvedCopyForBackCompat = result?.improvedCopy ||
        (generatedVersions.length > 0 ? generatedVersions[0].content : '');

      setFormState(prev => ({
        ...prev,
        projectDescription: workingFormState.projectDescription, // Ensure projectDescription is saved
        productServiceName: workingFormState.productServiceName, // Ensure productServiceName is saved
        sessionId: workingFormState.sessionId,
        copyResult: {
          improvedCopy: improvedCopyForBackCompat, // Keep for backward compatibility
          generatedVersions
        }
      }));
      addProgressMessage('Copy generation complete.');
      toast.success('Copy generated successfully!');
      playSuccessSound();
      triggerGuidanceHint('after_generate');

      // Trigger automatic comparison if workflow requested it
      if (shouldTriggerComparison) {
        addProgressMessage('Triggering automatic comparison and analysis...');
        // Use setTimeout to ensure formState has updated
        setTimeout(async () => {
          try {
            await compareOutputsWithGrok(false, workflowScoringContext);
          } catch (compError: any) {
            console.error('Error triggering automatic comparison:', compError);
            toast.error('Workflow completed, but comparison failed. You can trigger it manually.');
          }
        }, 1000);
      }
    } catch (error: any) {
      console.error('Error generating copy:', error);

      // Check if it's an API key error (but exclude subscription/credits errors)
      const errorMessage = error.message || '';
      const isSubscriptionError = errorMessage.includes('subscription') ||
                                  errorMessage.includes('consumed all your available credits');
      const isApiKeyError = !isSubscriptionError && (
        errorMessage.includes('API key') ||
        errorMessage.includes('401') ||
        (errorMessage.includes('403') && (errorMessage.includes('API key') || errorMessage.includes('not configured'))) ||
        errorMessage.includes('Incorrect API key') ||
        errorMessage.includes('Invalid API key') ||
        errorMessage.includes('not configured')
      );

      if (isApiKeyError) {
        // Check if this is a Supabase secret configuration issue
        const isSupabaseSecretIssue = errorMessage.includes('not configured') ||
                                       errorMessage.includes('No API keys configured');

        if (isSupabaseSecretIssue) {
          toast.error('API keys not configured in Supabase. Check CONFIGURE_SUPABASE_SECRETS.md for setup instructions.');
        } else {
          toast.error('AI Model unavailable. Please select an alternative model.');
        }
        // Trigger the model validation modal by throwing a specific error
        // that the parent component can catch and handle
        throw new Error('API_KEY_FAILED');
      } else {
        toast.error(`Failed to generate copy: ${error.message}`);
      }
    } finally {
      setFormState(prev => ({ ...prev, isLoading: false }));
    }
  };

  // Handle on-demand generation for content cards
  const handleOnDemandGeneration = async (
    actionType: 'alternative' | 'score' | 'restyle',
    sourceItem: GeneratedContentItem,
    selectedPersona?: string,
    voiceInstructions?: string
  ) => {
    if (!currentUser || !formState || !setFormState || !addProgressMessage) {
      toast.error('Please log in to generate copy.');
      return;
    }

    // Check user access before on-demand generation
    try {
      const accessResult = await checkUserAccess(currentUser.id, currentUser.email || '');

      if (!accessResult.hasAccess) {
        if (onAccessDenied) {
          onAccessDenied();
        } else {
          toast.error(accessResult.message);
        }
        return;
      }
    } catch (error) {
      console.error('Error checking user access for on-demand generation:', error);
      toast.error("Unable to verify access. Please try again.");
      return;
    }

    setFormState(prev => ({ ...prev, isLoading: true, generationProgress: [] }));
    addProgressMessage(`Starting ${actionType} generation...`);

    // Ensure we have a session ID (create one if needed)
    let actualSessionId = formState.sessionId;

    if (!actualSessionId) {
      console.log('📝 No saved session - creating one for on-demand generation tracking');
      try {
        actualSessionId = await ensureActiveSession(
          currentUser.id,
          formState.outputType,
          formState.projectDescription,
          formState.customerId,
          formState
        );
        console.log('✅ Created session for on-demand generation:', actualSessionId);

        // Update formState with new session ID
        setFormState(prev => ({
          ...prev,
          sessionId: actualSessionId
        }));
      } catch (error: any) {
        console.error('❌ Failed to create session for on-demand generation:', error);
        toast.error('Failed to create tracking session. Please retry.');
        setFormState(prev => ({ ...prev, isLoading: false }));
        return;
      }
    } else {
      console.log('📝 Using existing session for on-demand generation:', actualSessionId);
    }

    try {
      // For alternatives and scores, use form target word count
      const formTargetWordCount = calculateTargetWordCount(formState);

      // For restyle, use the word count of the source content to preserve its length
      const restyleTargetWordCount = actionType === 'restyle' ? extractWordCount(sourceItem.content) : formTargetWordCount.target;

      let newItem: GeneratedContentItem | null = null;

      if (actionType === 'alternative') {
        addProgressMessage(`Generating alternative version of ${sourceItem.sourceDisplayName || sourceItem.type}...`);

        // Fetch brand voice name if brandVoiceId is set
        const brandVoiceName = await getBrandVoiceName(formState.brandVoiceId);

        // Detect if source content is plain text (markdown) or structured JSON
        const isSourcePlainText = typeof sourceItem.content === 'string';

        // Use the source card's actual word count to match its length
        const sourceWordCount = extractWordCount(sourceItem.content);

        // Create modified formState: if source is plain text, clear outputStructure to generate plain text
        // Always match the source card's word count instead of the form setting
        const alternativeFormState = isSourcePlainText
          ? { ...formState, outputStructure: [], wordCount: 'Custom' as const, customWordCount: sourceWordCount, adhereToLittleWordCount: false, aiDecideWordCount: false }
          : { ...formState, wordCount: 'Custom' as const, customWordCount: sourceWordCount, adhereToLittleWordCount: false, aiDecideWordCount: false };

        const alternativeContent = await generateAlternativeCopy(alternativeFormState, sourceItem.content, currentUser, actualSessionId, addProgressMessage);
        newItem = {
          id: uuidv4(),
          type: GeneratedContentItemType.Alternative,
          content: alternativeContent,
          sourceText: sourceItem.content, // Store source content for evidence analysis
          generatedAt: new Date().toISOString(),
          sourceId: sourceItem.id,
          sourceType: sourceItem.type,
          sourceDisplayName: `Alternative: ${sourceItem.sourceDisplayName || sourceItem.type}`,
          brandVoiceName,
          analysisMode: 'on_demand' // On-demand generated content always uses on-demand mode
        };
        addProgressMessage('Alternative version generated.');
        
        // Generate SEO metadata if enabled
        if (formState.generateSeoMetadata) {
          addProgressMessage('Generating SEO metadata for alternative content...');
          try {
            const seoMetadata = await generateSeoMetadata(alternativeContent, formState, currentUser, addProgressMessage);
            newItem.seoMetadata = seoMetadata;
            addProgressMessage('SEO metadata generated for alternative content.');
          } catch (seoError) {
            console.error('Error generating SEO metadata for alternative:', seoError);
            addProgressMessage('Error generating SEO metadata for alternative, continuing...');
          }
        }
        
        // Generate content scores if enabled
        if (formState.generateScores) {
          addProgressMessage('Generating score for alternative content...');
          try {
            const score = await generateContentScores(
              alternativeContent,
              newItem.sourceDisplayName || newItem.type,
              formState.model,
              currentUser,
              sourceItem.content,
              calculateTargetWordCount(formState).target,
              actualSessionId,
              addProgressMessage
            );
            newItem.score = score;
            addProgressMessage('Score generated for alternative content.');
          } catch (scoreError) {
            console.error('Error generating score for alternative:', scoreError);
            addProgressMessage('Error generating score for alternative, continuing...');
          }
        }

        // Absolute score (always runs)
        try {
          const absScore = await generateAbsoluteScore(alternativeContent, currentUser, actualSessionId);
          newItem.absoluteScore = absScore;
          if (currentUser?.id) saveAbsoluteScore(currentUser.id, newItem.id, absScore, actualSessionId);
        } catch { /* non-critical */ }

        // Generate GEO score if enabled
        if (formState.generateGeoScore) {
          addProgressMessage('Calculating GEO score for alternative content...');
          try {
            const geoScore = await calculateGeoScore(alternativeContent, formState, currentUser, addProgressMessage);
            newItem.geoScore = geoScore;
            addProgressMessage('GEO score calculated for alternative content.');
          } catch (geoError) {
            console.error('Error calculating GEO score for alternative:', geoError);
            addProgressMessage('Error calculating GEO score for alternative, continuing...');
          }
        }
      } else if (actionType === 'restyle' && selectedPersona) {
        // Check if source content exists
        if (!sourceItem.content) {
          throw new Error('No content available to restyle. Please regenerate the content first.');
        }

        // Fetch brand voice name if brandVoiceId is set
        const brandVoiceName = await getBrandVoiceName(formState.brandVoiceId);

        // Detect if source content is plain text (markdown) or structured JSON
        const isSourcePlainText = typeof sourceItem.content === 'string';

        // Create modified formState: if source is plain text, clear outputStructure to generate plain text
        const restyleFormState = isSourcePlainText
          ? { ...formState, outputStructure: [] }
          : formState;

        addProgressMessage(`Applying ${selectedPersona}'s voice to ${sourceItem.sourceDisplayName || sourceItem.type}...`);
        const { content: restyledContent, personaUsed } = await restyleCopyWithPersona(
          sourceItem.content,
          selectedPersona,
          formState.model,
          currentUser,
          formState.language,
          restyleFormState,
          restyleTargetWordCount,
          actualSessionId,
          addProgressMessage,
          voiceInstructions
        );

        // Validate that restyledContent is not empty or invalid
        if (isContentEmpty(restyledContent)) {
          toast.error(`Failed to generate ${selectedPersona}'s voice style. The AI returned empty content. Please try again or use a different model.`);
          return;
        }

        // Ensure personaUsed is defined, fallback to selectedPersona
        const effectivePersona = personaUsed || selectedPersona || 'Unknown Persona';

        newItem = {
          id: uuidv4(),
          type: GeneratedContentItemType.RestyledImproved,
          content: restyledContent,
          sourceText: sourceItem.content, // Store source content for evidence analysis
          persona: effectivePersona,
          generatedAt: new Date().toISOString(),
          sourceId: sourceItem.id,
          sourceType: sourceItem.type,
          sourceDisplayName: `${effectivePersona}'s Voice from ${sourceItem.sourceDisplayName || sourceItem.type}`,
          ...(voiceInstructions && { modificationInstruction: voiceInstructions }),
          brandVoiceName,
          analysisMode: 'on_demand' // On-demand generated content always uses on-demand mode
        };
        addProgressMessage(`Applied ${effectivePersona}'s voice style.`);
        
        // Add FAQ schema if it was generated in the response
        if (typeof restyledContent === 'object' && 'faqSchema' in restyledContent) {
          newItem.faqSchema = restyledContent.faqSchema;
          // Extract actual content if it's nested
          if ('content' in restyledContent) {
            newItem.content = restyledContent.content;
          }
        }
        
        // Generate SEO metadata if enabled
        if (formState.generateSeoMetadata) {
          addProgressMessage(`Generating SEO metadata for ${effectivePersona}'s voice content...`);
          try {
            const seoMetadata = await generateSeoMetadata(newItem.content, formState, currentUser, addProgressMessage);
            newItem.seoMetadata = seoMetadata;
            addProgressMessage(`SEO metadata generated for ${effectivePersona}'s voice content.`);
          } catch (seoError) {
            console.error(`Error generating SEO metadata for ${effectivePersona}'s voice:`, seoError);
            addProgressMessage(`Error generating SEO metadata for ${effectivePersona}'s voice, continuing...`);
          }
        }
        
        // Generate content scores if enabled
        if (formState.generateScores) {
          addProgressMessage(`Generating score for ${effectivePersona}'s voice content...`);
          try {
            const score = await generateContentScores(
              newItem.content,
              newItem.sourceDisplayName || newItem.type,
              formState.model,
              currentUser,
              sourceItem.content,
              restyleTargetWordCount,
              actualSessionId,
              addProgressMessage
            );
            newItem.score = score;
            addProgressMessage(`Score generated for ${effectivePersona}'s voice content.`);
          } catch (scoreError) {
            console.error(`Error generating score for ${effectivePersona}'s voice:`, scoreError);
            addProgressMessage(`Error generating score for ${effectivePersona}'s voice, continuing...`);
          }
        }

        // Absolute score (always runs)
        try {
          const absScore = await generateAbsoluteScore(newItem.content, currentUser, actualSessionId);
          newItem.absoluteScore = absScore;
          if (currentUser?.id) saveAbsoluteScore(currentUser.id, newItem.id, absScore, actualSessionId);
        } catch { /* non-critical */ }

        // Generate GEO score if enabled
        if (formState.generateGeoScore) {
          addProgressMessage(`Calculating GEO score for ${effectivePersona}'s voice content...`);
          try {
            const geoScore = await calculateGeoScore(newItem.content, formState, currentUser, addProgressMessage);
            newItem.geoScore = geoScore;
            addProgressMessage(`GEO score calculated for ${effectivePersona}'s voice content.`);
          } catch (geoError) {
            console.error(`Error calculating GEO score for ${effectivePersona}'s voice:`, geoError);
            addProgressMessage(`Error calculating GEO score for ${effectivePersona}'s voice, continuing...`);
          }
        }
      } else if (actionType === 'score') {
        // Check if source content exists
        if (!sourceItem.content) {
          throw new Error('No content available to score. Please regenerate the content first.');
        }
        addProgressMessage(`Generating score for ${sourceItem.sourceDisplayName || sourceItem.type}...`);
        const formTargetWordCount = calculateTargetWordCount(formState);
        const score = await generateContentScores(
          sourceItem.content,
          sourceItem.sourceDisplayName || sourceItem.type,
          formState.model,
          currentUser,
          undefined,
          formTargetWordCount.target,
          actualSessionId,
          addProgressMessage
        );
        // Update the existing item with the score
        setFormState(prev => ({
          ...prev,
          copyResult: {
            ...prev.copyResult,
            generatedVersions: prev.copyResult?.generatedVersions?.map(item =>
              item.id === sourceItem.id ? { ...item, score: score } : item
            ) || []
          }
        }));
        addProgressMessage('Score generated.');
        toast.success('Score generated successfully!');
        return; // Exit early as we updated an existing item
      }

      // Add the new item to the generated versions
      if (newItem) {
        setFormState(prev => ({
          ...prev,
          copyResult: {
            ...prev.copyResult,
            // Keep all existing outputs including analysis cards
            generatedVersions: [
              ...(prev.copyResult?.generatedVersions || []),
              newItem
            ],
            comparisonDeepAnalysisMeta: undefined,
          }
        }));
        addProgressMessage(`${actionType} generation complete.`);
        toast.success(`${actionType} generated successfully!`);

        // Trigger callback if there's an existing comparison
        if (formState.copyResult?.comparisonResult && onNewOutputAdded) {
          onNewOutputAdded(1);
        }
      }
    } catch (error: any) {
      console.error(`Error generating ${actionType}:`, error);
      toast.error(`Failed to generate ${actionType}: ${error.message}`);
    } finally {
      setFormState(prev => ({ ...prev, isLoading: false }));
    }
  };

  // Handle content modification
  const handleModifyContent = async (sourceItem: GeneratedContentItem, instruction: string) => {
    if (!currentUser || !formState || !setFormState || !addProgressMessage) {
      toast.error('Please log in to modify content.');
      return;
    }

    // Check user access before modification
    try {
      const accessResult = await checkUserAccess(currentUser.id, currentUser.email || '');

      if (!accessResult.hasAccess) {
        if (onAccessDenied) {
          onAccessDenied();
        } else {
          toast.error(accessResult.message);
        }
        return;
      }
    } catch (error) {
      console.error('Error checking user access for content modification:', error);
      toast.error("Unable to verify access. Please try again.");
      return;
    }

    setFormState(prev => ({ ...prev, isLoading: true, generationProgress: [] }));
    addProgressMessage(`Modifying content: "${instruction}"...`);

    // Ensure we have a session ID (create one if needed)
    let actualSessionId = formState.sessionId;

    if (!actualSessionId) {
      console.log('📝 No saved session - creating one for content modification tracking');
      try {
        actualSessionId = await ensureActiveSession(
          currentUser.id,
          formState.outputType,
          formState.projectDescription,
          formState.customerId,
          formState
        );
        console.log('✅ Created session for content modification:', actualSessionId);

        // Update formState with new session ID
        setFormState(prev => ({
          ...prev,
          sessionId: actualSessionId
        }));
      } catch (error: any) {
        console.error('❌ Failed to create session for content modification:', error);
        toast.error('Failed to create tracking session. Please retry.');
        setFormState(prev => ({ ...prev, isLoading: false }));
        return;
      }
    } else {
      console.log('📝 Using existing session for content modification:', actualSessionId);
    }

    try {
      // Fetch brand voice name if brandVoiceId is set
      const brandVoiceName = await getBrandVoiceName(formState.brandVoiceId);

      // Import the modification function
      const { modifyContent } = await import('../../../../services/apiService');

      // Match the source card's word count unless the user's instruction implies a different length
      const modifySourceWordCount = extractWordCount(sourceItem.content);
      const modifyFormState = { ...formState, wordCount: 'Custom' as const, customWordCount: modifySourceWordCount, adhereToLittleWordCount: false, aiDecideWordCount: false };

      const modifiedContent = await modifyContent(
        sourceItem.content,
        instruction,
        modifyFormState,
        currentUser,
        addProgressMessage,
        actualSessionId
      );

      const newItem: GeneratedContentItem = {
        id: uuidv4(),
        type: GeneratedContentItemType.Alternative,
        content: modifiedContent,
        sourceText: sourceItem.content, // Store source content for evidence analysis
        generatedAt: new Date().toISOString(),
        sourceId: sourceItem.id,
        sourceType: sourceItem.type,
        sourceDisplayName: `Modified: ${sourceItem.sourceDisplayName || sourceItem.type}`,
        modificationInstruction: instruction,
        brandVoiceName,
        analysisMode: 'on_demand' // On-demand generated content always uses on-demand mode
      };

      // Generate SEO metadata if enabled
      if (formState.generateSeoMetadata) {
        addProgressMessage('Generating SEO metadata for modified content...');
        try {
          const seoMetadata = await generateSeoMetadata(modifiedContent, formState, currentUser, addProgressMessage);
          newItem.seoMetadata = seoMetadata;
          addProgressMessage('SEO metadata generated for modified content.');
        } catch (seoError) {
          console.error('Error generating SEO metadata for modified content:', seoError);
          addProgressMessage('Error generating SEO metadata for modified content, continuing...');
        }
      }
      
      // Generate content scores if enabled
      if (formState.generateScores) {
        addProgressMessage('Generating score for modified content...');
        try {
          const formTargetWordCount = calculateTargetWordCount(formState);
          const score = await generateContentScores(
            modifiedContent,
            newItem.sourceDisplayName || newItem.type,
            formState.model,
            currentUser,
            sourceItem.content,
            formTargetWordCount.target,
            actualSessionId,
            addProgressMessage
          );
          newItem.score = score;
          addProgressMessage('Score generated for modified content.');
        } catch (scoreError) {
          console.error('Error generating score for modified content:', scoreError);
          addProgressMessage('Error generating score for modified content, continuing...');
        }
      }
      
      // Generate GEO score if enabled
      if (formState.generateGeoScore) {
        addProgressMessage('Calculating GEO score for modified content...');
        try {
          const geoScore = await calculateGeoScore(modifiedContent, formState, currentUser, addProgressMessage);
          newItem.geoScore = geoScore;
          addProgressMessage('GEO score calculated for modified content.');
        } catch (geoError) {
          console.error('Error calculating GEO score for modified content:', geoError);
          addProgressMessage('Error calculating GEO score for modified content, continuing...');
        }
      }

      // Add the new item to the generated versions
      setFormState(prev => ({
        ...prev,
        copyResult: {
          ...prev.copyResult,
          // Keep all existing outputs including analysis cards
          generatedVersions: [
            ...(prev.copyResult?.generatedVersions || []),
            newItem
          ],
          comparisonDeepAnalysisMeta: undefined,
        }
      }));
      addProgressMessage('Content modification complete.');
      toast.success('Content modified successfully!');

      // Trigger callback if there's an existing comparison
      if (formState.copyResult?.comparisonResult && onNewOutputAdded) {
        onNewOutputAdded(1);
      }
    } catch (error: any) {
      console.error('Error modifying content:', error);
      toast.error(`Failed to modify content: ${error.message}`);
    } finally {
      setFormState(prev => ({ ...prev, isLoading: false }));
    }
  };

  // Handle Performance Boost — creates a new boosted output from an existing one
  const handlePerformanceBoost = async (sourceItem: GeneratedContentItem): Promise<void> => {
    if (!currentUser || !formState || !setFormState || !addProgressMessage) {
      toast.error('Please log in to boost content.');
      return;
    }

    try {
      const accessResult = await checkUserAccess(currentUser.id, currentUser.email || '');
      if (!accessResult.hasAccess) {
        if (onAccessDenied) {
          onAccessDenied();
        } else {
          toast.error(accessResult.message);
        }
        return;
      }
    } catch {
      toast.error('Unable to verify access. Please try again.');
      return;
    }

    // Determine base name and boost iteration
    const baseName = sourceItem.baseName || sourceItem.sourceDisplayName || sourceItem.type;

    // Count existing boosts on the same base version across all outputs
    const allVersions = formState.copyResult?.generatedVersions || [];
    const existingBoosts = allVersions.filter(
      v => v.type === GeneratedContentItemType.Boosted &&
        (v.parentOutputId === sourceItem.id || v.baseName === baseName)
    );
    const nextIteration = existingBoosts.length + 1;

    if (nextIteration > MAX_BOOST_ITERATIONS) {
      toast.error(`Further boosting may reduce authenticity. Maximum ${MAX_BOOST_ITERATIONS} boosts reached.`);
      return;
    }

    // Check if already at max score threshold
    const cachedScores = formState.copyResult?.versionScores;
    const existingScore = cachedScores?.[sourceItem.id];
    if (existingScore && existingScore.finalScore >= MAX_BOOST_SCORE_THRESHOLD * 10) {
      toast('This output already scores at or above 9.0 — boosting is disabled.', { icon: '🏆' });
      return;
    }

    setFormState(prev => ({ ...prev, isLoading: true, generationProgress: [] }));
    addProgressMessage('🚀 Boosting performance...');

    let actualSessionId = formState.sessionId;
    if (!actualSessionId) {
      try {
        actualSessionId = await ensureActiveSession(
          currentUser.id,
          formState.outputType,
          formState.projectDescription,
          formState.customerId,
          formState
        );
        setFormState(prev => ({ ...prev, sessionId: actualSessionId }));
      } catch {
        toast.error('Failed to create tracking session. Please retry.');
        setFormState(prev => ({ ...prev, isLoading: false }));
        return;
      }
    }

    try {
      const { performBoost } = await import('../../../../services/api/performanceBoost');
      const brandVoiceName = await getBrandVoiceName(formState.brandVoiceId);

      // Retrieve scoring breakdown if available
      const scoreResult = cachedScores?.[sourceItem.id] ?? null;

      const boostedContent = await performBoost(
        sourceItem.content,
        scoreResult,
        formState,
        currentUser,
        addProgressMessage,
        actualSessionId
      );

      const iterationSuffix = nextIteration === 1
        ? '— Boosted 🚀'
        : `— Boosted 🚀 (${nextIteration})`;

      const displayName = `${baseName} ${iterationSuffix}`;

      const newItem: GeneratedContentItem = {
        id: uuidv4(),
        type: GeneratedContentItemType.Boosted,
        content: boostedContent,
        sourceText: sourceItem.content,
        generatedAt: new Date().toISOString(),
        sourceId: sourceItem.id,
        sourceType: sourceItem.type,
        sourceDisplayName: displayName,
        baseName,
        parentOutputId: sourceItem.id,
        boostIteration: nextIteration,
        boostLevel: 'lite',
        brandVoiceName,
        analysisMode: 'on_demand',
      };

      if (formState.generateSeoMetadata) {
        addProgressMessage('Generating SEO metadata for boosted content...');
        try {
          const seoMetadata = await generateSeoMetadata(boostedContent, formState, currentUser, addProgressMessage);
          newItem.seoMetadata = seoMetadata;
        } catch {
          addProgressMessage('SEO metadata generation skipped.');
        }
      }

      if (formState.generateScores) {
        addProgressMessage('Scoring boosted content...');
        try {
          const twc = calculateTargetWordCount(formState);
          const score = await generateContentScores(
            boostedContent,
            displayName,
            formState.model,
            currentUser,
            sourceItem.content,
            twc.target,
            actualSessionId,
            addProgressMessage
          );
          newItem.score = score;
        } catch {
          addProgressMessage('Scoring skipped.');
        }
      }

      if (formState.generateGeoScore) {
        addProgressMessage('Calculating GEO score for boosted content...');
        try {
          const geoScore = await calculateGeoScore(boostedContent, formState, currentUser, addProgressMessage);
          newItem.geoScore = geoScore;
        } catch {
          addProgressMessage('GEO score skipped.');
        }
      }

      setFormState(prev => ({
        ...prev,
        copyResult: {
          ...prev.copyResult,
          generatedVersions: [
            ...(prev.copyResult?.generatedVersions || []),
            newItem,
          ],
          comparisonDeepAnalysisMeta: undefined,
        },
      }));

      addProgressMessage('🚀 Performance Boost complete!');
      toast.success('Boosted version created!');

      // Trigger callback if there's an existing comparison
      if (formState.copyResult?.comparisonResult && onNewOutputAdded) {
        onNewOutputAdded(1);
      }
    } catch (error: any) {
      console.error('Error during performance boost:', error);
      toast.error(`Boost failed: ${error.message}`);
    } finally {
      setFormState(prev => ({ ...prev, isLoading: false }));
    }
  };

  // Handle FAQ schema generation
  const handleGenerateFaqSchema = async (content: string) => {
    if (!currentUser || !formState || !setFormState || !addProgressMessage) {
      toast.error('Please log in to generate FAQ schema.');
      return;
    }

    try {
      const accessResult = await checkUserAccess(currentUser.id, currentUser.email || '');

      if (!accessResult.hasAccess) {
        if (onAccessDenied) {
          onAccessDenied();
        } else {
          toast.error(accessResult.message);
        }
        return;
      }
    } catch (error) {
      console.error('Error checking user access for FAQ schema generation:', error);
      toast.error("Unable to verify access. Please try again.");
      return;
    }

    setFormState(prev => ({ ...prev, isLoading: true, generationProgress: [] }));
    addProgressMessage('Generating FAQ schema...');

    try {
      // Generate FAQ schema (you'll need to implement this function)
      const faqSchema = await generateSeoMetadata(content, formState, currentUser, addProgressMessage);
      // This would need additional logic to show the schema
      addProgressMessage('FAQ schema generated.');
      toast.success('FAQ schema generated successfully!');
    } catch (error: any) {
      console.error('Error generating FAQ schema:', error);
      toast.error(`Failed to generate FAQ schema: ${error.message}`);
    } finally {
      setFormState(prev => ({ ...prev, isLoading: false }));
    }
  };

  // Handle cancel operation
  const handleCancelOperation = () => {
    if (setFormState) {
      setFormState(prev => ({ ...prev, isLoading: false, isEvaluating: false }));
    }
    toast.info('Operation cancelled');
  };

  // Compare outputs with Grok (always uses Comprehensive Analysis)
  const compareOutputsWithGrok = async (
    isIncremental: boolean = false,
    scoringContext?: ScoringContext
  ) => {
    if (!currentUser || !formState || !setFormState || !addProgressMessage) {
      toast.error('Please log in to compare outputs.');
      return;
    }

    // CRITICAL: Use setFormState with callback to get the LATEST state
    // The formState parameter might be stale due to closures
    let latestFormState: FormState | null = null;
    setFormState(prev => {
      latestFormState = prev;
      return prev; // Don't actually change the state
    });

    if (!latestFormState) {
      toast.error('Unable to access current state.');
      return;
    }

    // Get generated versions from LATEST state
    const allGeneratedVersions = latestFormState.copyResult?.generatedVersions || [];

    // Find existing analysis card (if any)
    const existingAnalysisCard = allGeneratedVersions.find(v => v.comparedContent);
    const existingAnalyzedIds = existingAnalysisCard?.analyzedOutputIds || [];
    const existingComparisonResult = latestFormState.copyResult?.comparisonResult;

    // Filter out the analysis card itself from the outputs list
    const generatedVersions = allGeneratedVersions.filter(v => !v.comparedContent);

    // Ensure original copy is always included as baseline
    const originalCopyText = latestFormState.originalCopy?.trim() || undefined;
    const versionsWithOriginal = ensureOriginalVersion(generatedVersions, originalCopyText);

    // Generate absolute score for the original copy if it doesn't have one yet
    const originalItem = versionsWithOriginal.find(v => v.id === ORIGINAL_VERSION_ID);
    if (originalItem && !originalItem.absoluteScore && originalCopyText) {
      try {
        const absScore = await generateAbsoluteScore(originalCopyText, currentUser, latestFormState.sessionId);
        originalItem.absoluteScore = absScore;
        if (currentUser?.id && latestFormState.sessionId) {
          saveAbsoluteScore(currentUser.id, ORIGINAL_VERSION_ID, absScore, latestFormState.sessionId);
        }
        // Persist the absolute score on the original item in form state so absoluteScoreMap picks it up
        setFormState(prev => {
          const versions = prev.copyResult?.generatedVersions ?? [];
          const exists = versions.some(v => v.id === ORIGINAL_VERSION_ID);
          const updated = exists
            ? versions.map(v => v.id === ORIGINAL_VERSION_ID ? { ...v, absoluteScore: absScore } : v)
            : [{ ...originalItem, absoluteScore: absScore }, ...versions];
          return {
            ...prev,
            copyResult: { ...prev.copyResult, generatedVersions: updated }
          };
        });
      } catch { /* non-critical — delta will show "—" if scoring fails */ }
    }

    // Determine which outputs to analyze
    let outputsToAnalyze = versionsWithOriginal;
    let isIncrementalUpdate = false;

    if (isIncremental && existingAnalysisCard && existingAnalyzedIds.length > 0) {
      // Incremental mode: only score NEW outputs (original already scored in prior run)
      const newOutputsOnly = generatedVersions.filter(v => !existingAnalyzedIds.includes(v.id));
      outputsToAnalyze = newOutputsOnly;
      isIncrementalUpdate = true;

      if (outputsToAnalyze.length === 0) {
        toast.info('No new outputs to analyze.');
        return;
      }

      addProgressMessage?.(`Found ${outputsToAnalyze.length} new output${outputsToAnalyze.length !== 1 ? 's' : ''} to analyze...`);
    } else {
      // Full analysis mode — use all versions including original
      outputsToAnalyze = versionsWithOriginal;
      isIncrementalUpdate = false;
    }

    // Check if we have enough items to compare (need at least 2)
    if (isIncrementalUpdate) {
      if (outputsToAnalyze.length === 0) {
        toast.error('No new outputs to add to the analysis.');
        return;
      }
    } else {
      if (versionsWithOriginal.length < 2) {
        toast.error('Need at least 2 items to compare (Original Copy counts as one item).');
        return;
      }
    }

    // Check user access before comparison
    try {
      const accessResult = await checkUserAccess(currentUser.id, currentUser.email || '');

      if (!accessResult.hasAccess) {
        if (onAccessDenied) {
          onAccessDenied();
        } else {
          toast.error(accessResult.message);
        }
        return;
      }
    } catch (error) {
      console.error('Error checking user access for comparison:', error);
      toast.error("Unable to verify access. Please try again.");
      return;
    }

    // Use same model for analysis as generation (user's selected model)
    const analysisModelName = latestFormState.model ? (latestFormState.model.includes('claude') ? 'Claude' : latestFormState.model.includes('gpt') ? 'OpenAI' : 'Selected Model') : 'Claude';

    setIsComparing(true);
    setFormState(prev => ({ ...prev, isLoading: true, generationProgress: [] }));
    if (isIncrementalUpdate) {
      addProgressMessage(`Updating analysis with ${outputsToAnalyze.length} new output${outputsToAnalyze.length !== 1 ? 's' : ''}...`);
    } else {
      addProgressMessage(`Preparing outputs for comparison analysis...`);
    }

    console.log('🔄 About to ensure active session...');
    console.log('Current user:', currentUser);
    console.log('Session params:', {
      userId: currentUser.id,
      existingSessionId: latestFormState.sessionId,
      projectDescription: latestFormState.projectDescription || 'Comparison',
      customerId: latestFormState.customerId
    });

    // Ensure we have a session ID (create one if needed)
    let workingSessionId = latestFormState.sessionId;

    if (!workingSessionId) {
      debugCompare.log('No saved session - creating one for comparison tracking');
      try {
        workingSessionId = await ensureActiveSession(
          currentUser.id,
          'comparison',
          latestFormState.projectDescription || 'Comparison Analysis',
          latestFormState.customerId,
          latestFormState
        );
        debugCompare.log('✅ Created session for comparison:', workingSessionId);

        // Update formState with new session ID
        setFormState(prev => ({
          ...prev,
          sessionId: workingSessionId
        }));
      } catch (error) {
        console.error('Failed to create session for comparison:', error);
        toast.error('Failed to create session. Please try again.');
        setFormState(prev => ({ ...prev, isLoading: false }));
        return;
      }
    } else {
      console.log('Using existing session:', workingSessionId);
    }

    addProgressMessage('Starting comparison...');

    try {
      // For incremental updates, only score new outputs; full mode uses all versions including original
      const versionsForAnalysis = isIncrementalUpdate ? outputsToAnalyze : versionsWithOriginal;

      // Get existing cache
      const existingCache = latestFormState.copyResult?.versionScores || {};

      // Import cache utilities
      const { updateScoreCache, buildContextKey } = await import('../../../../utils/versionScoreCache');

      const parsedKw = parseKeywordsString(latestFormState.keywords);
      const scoringKeywords = latestFormState.keywordsExplicit ? parsedKw : [];

      if (import.meta.env.DEV) {
        console.log(
          `[scoringPayload] useCaseKey=${scoringContext?.useCaseKey ?? '(none)'} useCaseLabel=${scoringContext?.useCaseLabel ?? '(none)'} keywordsCount=${scoringKeywords.length} keywords=${JSON.stringify(scoringKeywords)}`
        );
      }

      if (import.meta.env.DEV) {
        console.log('[LAZY-SCORING] EXECUTIVE CALL — scoring only, no detailed analysis', {
          versions: versionsForAnalysis.map(v => v.sourceDisplayName || v.type),
          caller: 'compareOutputsWithGrok'
        });
      }

      const unifiedResult = await generateUnifiedComparison(
        originalCopyText,
        versionsForAnalysis,
        currentUser,
        workingSessionId,
        addProgressMessage,
        latestFormState.model,
        existingCache,
        scoringKeywords,
        scoringContext,
        latestFormState.section || 'Marketing Copy'
      );

      console.log('✅ generateUnifiedComparison completed successfully');

      let { comparisonResult, modelUsed } = unifiedResult;

      // phase 2 scoring cleanup: comparative scoring doesn't use cache
      // Comparative scoring evaluates all versions together, so incremental caching is not supported

      // comp-v6.7.3: Guarantee decision layer fields are always present
      _repairDecisionLayerFields(comparisonResult);

      // Phase 2: Cache system disabled for comparative scoring
      const updatedCache = existingCache; // Keep existing cache but don't update it

      debugCompare.log('📊 Storing comparison result in state:', {
        comparisonResult,
        analyzedVersions: versionsForAnalysis.map(v => v.sourceDisplayName || v.type),
        cacheUpdated: Object.keys(updatedCache).length
      });

      setFormState(prev => ({
        ...prev,
        copyResult: {
          ...prev.copyResult,
          comparisonResult: comparisonResult,
          versionScores: updatedCache,
          comparisonDeepAnalysisMeta: undefined
        }
      }));

      addProgressMessage('Comparison complete! Generating detailed analysis...');
      // AUTO-GENERATE DEEP ANALYSIS FOR ALL VERSIONS
      // Derive the version list from comparisonResult.rows so that blended or other late-added
      // versions are always included — even if they weren't in versionsWithOriginal (which was
      // assembled before scoring ran).
      try {
        const allVersionsInState = (latestFormState.copyResult?.generatedVersions || []).filter(v => !v.comparedContent);
        const versionsForDeepAnalysis = ensureOriginalVersion(allVersionsInState, originalCopyText);
        // Also add any row IDs in comparisonResult that aren't covered yet (e.g. synthetic originals)
        const coveredIds = new Set(versionsForDeepAnalysis.map(v => v.id));
        const extraRows = comparisonResult.rows.filter((r: any) => !coveredIds.has(r.versionId) && r.versionId !== ORIGINAL_VERSION_ID);
        if (extraRows.length > 0) {
          console.warn('[deepAnalysis] rows in comparisonResult not found in state versions:', extraRows.map((r: any) => r.versionId));
        }
        const deepAnalysisResult = await runDeepAnalysisForAll(
          versionsForDeepAnalysis,
          comparisonResult,
          latestFormState,
          currentUser,
          workingSessionId,
          addProgressMessage
        );

        setFormState(prev => ({
          ...prev,
          copyResult: {
            ...prev.copyResult,
            versionDeepAnalysis: {
              ...(prev.copyResult?.versionDeepAnalysis || {}),
              ...deepAnalysisResult.versionAnalyses
            },
            comparisonDeepAnalysisMeta: deepAnalysisResult.meta
          }
        }));

        addProgressMessage('Analysis complete!');
      } catch (analysisError: any) {
        console.error('Auto-analysis failed:', analysisError);
        addProgressMessage('Analysis generation failed, but scoring is complete.');
      }

      toast.success('Analysis and scoring complete!');
      triggerGuidanceHint('after_score');
    } catch (error: any) {
      console.error('❌ Error comparing outputs:', error);
      console.error('❌ Error stack:', error.stack);
      console.error('❌ Error message:', error.message);

      // Show the actual error message if available
      let errorMessage = 'Analysis could not be completed. Please try again.';

      if (error.message) {
        // Check if it's a specific known error
        if (error.message.includes('API key')) {
          errorMessage = 'API configuration error. Please contact support.';
        } else if (error.message.includes('quota') || error.message.includes('rate limit')) {
          errorMessage = 'API rate limit reached. Please try again in a moment.';
        } else if (error.message.includes('parse') || error.message.includes('JSON')) {
          errorMessage = 'Unable to process analysis results. Please try again.';
        } else if (error.message.includes('No response') || error.message.includes('empty response')) {
          errorMessage = 'No response from AI service. Please try again.';
        } else if (error.message.includes('Network') || error.message.includes('timeout')) {
          errorMessage = 'Network error. Please check your connection and try again.';
        } else {
          // Show the actual error message
          errorMessage = `Analysis failed: ${error.message}`;
        }
      }

      toast.error(errorMessage);
    } finally {
      setIsComparing(false);
      setFormState(prev => ({ ...prev, isLoading: false }));
    }
  };

  // Generate detailed analysis on demand (called when user expands breakdown)
  const generateDetailedAnalysis = async () => {
    if (!currentUser || !formState || !setFormState) return;

    if (isGeneratingDetails) {
      if (import.meta.env.DEV) {
        console.warn('[LAZY-SCORING] generateDetailedAnalysis called while already in progress — ignored');
      }
      return;
    }

    if (import.meta.env.DEV) {
      console.log('[LAZY-SCORING] DETAILED CALL — user explicitly requested breakdown', {
        caller: 'generateDetailedAnalysis',
        stack: new Error('CALLER_TRACE').stack
      });
    }

    const latestFormState = formStateRef.current;
    if (!latestFormState) return;

    const comparisonResult = latestFormState.copyResult?.comparisonResult;
    if (!comparisonResult) return;

    if (latestFormState.copyResult?.versionDeepAnalysis && Object.keys(latestFormState.copyResult.versionDeepAnalysis).length > 0) {
      if (import.meta.env.DEV) {
        console.log('[LAZY-SCORING] Detailed analysis already cached — skipping API call');
      }
      return;
    }

    const generatedVersions = (latestFormState.copyResult?.generatedVersions || []).filter(v => !v.comparedContent);
    const originalCopyText = latestFormState.originalCopy?.trim() || undefined;
    const versionsWithOriginal = ensureOriginalVersion(generatedVersions, originalCopyText);

    let workingSessionId = latestFormState.sessionId;
    if (!workingSessionId) {
      try {
        workingSessionId = await ensureActiveSession(
          currentUser.id,
          'deep_analysis',
          latestFormState.projectDescription || 'Deep Analysis',
          latestFormState.customerId,
          latestFormState
        );
        setFormState(prev => ({ ...prev, sessionId: workingSessionId }));
      } catch (err) {
        toast.error('Failed to create session for detailed analysis.');
        return;
      }
    }

    setIsGeneratingDetails(true);
    addProgressMessage?.('Starting detailed analysis...');
    try {
      const deepAnalysisResult = await runDeepAnalysisForAll(
        versionsWithOriginal,
        comparisonResult,
        latestFormState,
        currentUser,
        workingSessionId || '',
        addProgressMessage
      );
      setFormState(prev => ({
        ...prev,
        copyResult: {
          ...prev.copyResult,
          versionDeepAnalysis: {
            ...(prev.copyResult?.versionDeepAnalysis || {}),
            ...deepAnalysisResult.versionAnalyses
          },
          comparisonDeepAnalysisMeta: deepAnalysisResult.meta
        }
      }));
      addProgressMessage?.('Detailed analysis complete!');
      toast.success('Detailed analysis ready!');
    } catch (error: any) {
      console.error('❌ Detailed analysis failed:', error);
      toast.error('Detailed analysis failed. Please try again.');
    } finally {
      setIsGeneratingDetails(false);
    }
  };

  // Generate deep analysis for a single specific version on explicit user action.
  // Skips silently if analysis already cached or already loading.
  const ensureVersionDeepAnalysis = async (versionId: string, freshComparisonResult?: any) => {
    if (!currentUser || !setFormState) {
      console.warn('[ensureVersionDeepAnalysis] bail: missing currentUser/setFormState', { versionId, hasUser: !!currentUser });
      return;
    }

    const latestFormState = formStateRef.current;
    if (!latestFormState) {
      console.warn('[ensureVersionDeepAnalysis] bail: latestFormState is null', { versionId });
      return;
    }

    // Already cached — do nothing
    if (latestFormState.copyResult?.versionDeepAnalysis?.[versionId]) {
      console.log('[ensureVersionDeepAnalysis] bail: already cached', { versionId });
      return;
    }

    // Already in-flight — do nothing
    if (loadingVersionIds.has(versionId)) {
      console.warn('[ensureVersionDeepAnalysis] bail: already in-flight', { versionId, loadingVersionIds: [...loadingVersionIds] });
      return;
    }

    // Prefer the freshly-returned comparison result (passed directly from the caller before state
    // propagates) so score lookups aren't stale for versions just added to the comparison.
    const comparisonResult = freshComparisonResult ?? latestFormState.copyResult?.comparisonResult;
    if (!comparisonResult) {
      console.warn('[ensureVersionDeepAnalysis] bail: no comparisonResult', { versionId });
      return;
    }

    // Resolve version content + label
    const allGeneratedVersions = latestFormState.copyResult?.generatedVersions || [];
    const generatedVersions = allGeneratedVersions.filter(v => !v.comparedContent);
    let targetContent: any;
    let optionLabel: string;

    if (versionId === ORIGINAL_VERSION_ID) {
      const originalContent = latestFormState.originalCopy?.trim();
      if (!originalContent) {
        console.warn('[ensureVersionDeepAnalysis] bail: no originalCopy', { versionId });
        return;
      }
      targetContent = originalContent;
      optionLabel = 'Original Copy';
    } else {
      const targetVersion = generatedVersions.find(v => v.id === versionId);
      if (!targetVersion) {
        const allIds = allGeneratedVersions.map(v => v.id);
        const filteredIds = generatedVersions.map(v => v.id);
        console.warn('[ensureVersionDeepAnalysis] bail: version not found in generatedVersions', { versionId, allIds, filteredIds });
        return;
      }
      targetContent = targetVersion.content;
      optionLabel = targetVersion.sourceDisplayName || targetVersion.type || 'Version';
    }

    // Ensure session
    let workingSessionId = latestFormState.sessionId;
    if (!workingSessionId) {
      try {
        workingSessionId = await ensureActiveSession(
          currentUser.id,
          'deep_analysis',
          latestFormState.projectDescription || 'Deep Analysis',
          latestFormState.customerId,
          latestFormState
        );
        setFormState(prev => ({ ...prev, sessionId: workingSessionId }));
      } catch {
        toast.error('Failed to create session for analysis.');
        return;
      }
    }

    setLoadingVersionIds(prev => new Set([...prev, versionId]));
    try {
      const { analyzeVersionDeep } = await import('../../../../services/api/versionDeepAnalysis');

      // Resolve score, parent score, and parent copy text for diff-aware evaluation
      const rows = comparisonResult.rows as any[];
      const thisRow = rows.find((r: any) => r.versionId === versionId);
      const targetVersion = generatedVersions.find(v => v.id === versionId);
      const currentScore: number | undefined =
        thisRow?.score ?? thisRow?.finalScore ??
        (typeof targetVersion?.score?.overall === 'number' ? targetVersion.score!.overall : undefined);
      const parentVersion = targetVersion?.sourceId
        ? generatedVersions.find(v => v.id === targetVersion.sourceId)
        : undefined;
      const parentRow = parentVersion
        ? rows.find((r: any) => r.versionId === parentVersion.id)
        : undefined;
      const parentScore: number | undefined =
        parentRow?.score ?? parentRow?.finalScore ??
        (typeof parentVersion?.score?.overall === 'number' ? parentVersion.score!.overall : undefined);
      const parentCopyText: string | undefined = parentVersion
        ? (typeof parentVersion.content === 'string'
            ? parentVersion.content
            : JSON.stringify(parentVersion.content))
        : undefined;

      const analysis = await analyzeVersionDeep(
        targetContent,
        optionLabel,
        latestFormState.model,
        currentUser,
        latestFormState,
        workingSessionId || '',
        undefined,
        currentScore,
        parentScore,
        parentCopyText
      );
      analysis.versionId = versionId;
      setFormState(prev => ({
        ...prev,
        copyResult: {
          ...prev.copyResult,
          versionDeepAnalysis: {
            ...(prev.copyResult?.versionDeepAnalysis || {}),
            [versionId]: analysis
          }
        }
      }));
    } catch (error: any) {
      console.error(`[ensureVersionDeepAnalysis] Failed for ${versionId}:`, error);
      toast.error('Analysis failed for this version. Please try again.');
    } finally {
      setLoadingVersionIds(prev => {
        const next = new Set(prev);
        next.delete(versionId);
        return next;
      });
    }
  };

  // Re-analyze all versions (clears deep analysis cache)
  const reanalyzeAllDeep = async () => {
    if (!currentUser || !formState || !setFormState) {
      toast.error('Please log in to run analysis.');
      return;
    }

    // Get latest state
    let latestFormState: FormState | null = null;
    setFormState(prev => {
      latestFormState = prev;
      return prev;
    });

    if (!latestFormState) {
      toast.error('Unable to access current state.');
      return;
    }

    const comparisonResult = latestFormState.copyResult?.comparisonResult;
    const generatedVersions = latestFormState.copyResult?.generatedVersions || [];

    if (!comparisonResult) {
      toast.error('Please run comparison first.');
      return;
    }

    if (generatedVersions.length === 0) {
      toast.error('No versions to analyze.');
      return;
    }

    let workingSessionId = latestFormState.sessionId;

    if (!workingSessionId) {
      try {
        workingSessionId = await ensureActiveSession(
          currentUser.id,
          'reanalysis',
          latestFormState.projectDescription || 'Deep Analysis',
          latestFormState.customerId,
          latestFormState
        );
        setFormState(prev => ({ ...prev, sessionId: workingSessionId }));
      } catch (error) {
        console.error('Failed to create session for re-analysis:', error);
        toast.error('Failed to create session. Please try again.');
        return;
      }
    }

    setFormState(prev => ({ ...prev, isLoading: true }));
    addProgressMessage?.('Re-analyzing all versions in detail...');

    try {
      // Clear existing deep analysis cache
      setFormState(prev => ({
        ...prev,
        copyResult: {
          ...prev.copyResult,
          versionDeepAnalysis: undefined,
          comparisonDeepAnalysisMeta: undefined
        }
      }));

      // Ensure original copy is included as baseline
      const originalCopyTextForReanalysis = latestFormState.originalCopy?.trim() || undefined;
      const versionsForReanalysis = ensureOriginalVersion(
        generatedVersions.filter(v => !v.comparedContent),
        originalCopyTextForReanalysis
      );

      // If comparisonResult doesn't yet have an original row, re-run scoring (uses cache — fast)
      let activeComparisonResult = comparisonResult;
      const hasOriginalInComparison = comparisonResult.rows.some(
        r => r.versionId === ORIGINAL_VERSION_ID || r.optionLabel === 'Original Copy'
      );
      if (!hasOriginalInComparison && originalCopyTextForReanalysis) {
        addProgressMessage?.('Updating comparison to include original...');
        const existingCache = latestFormState.copyResult?.versionScores || {};
        const refreshed = await generateUnifiedComparison(
          originalCopyTextForReanalysis,
          versionsForReanalysis,
          currentUser,
          workingSessionId,
          addProgressMessage,
          latestFormState.model,
          existingCache,
          latestFormState.keywordsExplicit ? parseKeywordsString(latestFormState.keywords) : []
        );
        activeComparisonResult = refreshed.comparisonResult;
        _repairDecisionLayerFields(activeComparisonResult);
        setFormState(prev => ({
          ...prev,
          copyResult: {
            ...prev.copyResult,
            comparisonResult: activeComparisonResult,
            versionScores: { ...(prev.copyResult?.versionScores || {}), ...existingCache }
          }
        }));
      }

      // Run deep analysis
      const deepAnalysisResult = await runDeepAnalysisForAll(
        versionsForReanalysis,
        activeComparisonResult,
        latestFormState,
        currentUser,
        workingSessionId,
        addProgressMessage
      );

      // Store results — merge with existing cache so on-demand diff-aware analyses aren't lost
      setFormState(prev => ({
        ...prev,
        copyResult: {
          ...prev.copyResult,
          versionDeepAnalysis: {
            ...(prev.copyResult?.versionDeepAnalysis || {}),
            ...deepAnalysisResult.versionAnalyses
          },
          comparisonDeepAnalysisMeta: deepAnalysisResult.meta
        }
      }));

      addProgressMessage?.('Detailed analysis complete!');
      toast.success('All versions re-analyzed successfully!');
    } catch (error: any) {
      console.error('❌ Re-analysis failed:', error);
      toast.error(error.message || 'Re-analysis failed. Please try again.');
    } finally {
      setFormState(prev => ({ ...prev, isLoading: false }));
    }
  };

  return {
    handleGenerate,
    handleOnDemandGeneration,
    handleModifyContent,
    handlePerformanceBoost,
    handleGenerateFaqSchema,
    handleCancelOperation,
    compareOutputsWithGrok,
    reanalyzeAllDeep,
    generateDetailedAnalysis,
    ensureVersionDeepAnalysis,
    isGeneratingDetails,
    loadingVersionIds,
    isComparing
  };
}