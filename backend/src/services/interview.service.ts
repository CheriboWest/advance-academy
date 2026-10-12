import type Anthropic from '@anthropic-ai/sdk';
import { assertLlmConfigured, createAnthropicClient, getFeatureModel } from '../lib/llm-anthropic.js';
import { getPersona } from '../lib/interview-prep/personas.js';
import { scoreAnswer } from '../lib/interview-prep/irs-scoring.js';
import {
  dbStartSession,
  dbStoreQuestion,
  dbQuestionBelongsToSession,
  dbSessionBelongsToUser,
  dbStoreAssessment,
  dbCompleteSession,
  dbUpdateSessionStatus,
} from '../lib/interview-prep/db.js';
import { generateFeedbackReport } from './feedback-engine.service.js';
import type {
  InterviewContext,
  StartSessionResponse,
  SendMessageResponse,
  StartSessionBody,
  SendMessageBody,
  EvaluateSessionBody,
  FeedbackReport,
} from '../types/interview-prep.js';

const CACHE_CONTROL_1H = { type: 'ephemeral' as const, ttl: '1h' as const };

async function measured<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const startedAt = performance.now();
  const value = await fn();
  return { value, durationMs: Math.round(performance.now() - startedAt) };
}

function logLatency(label: string, fields: Record<string, string | number | boolean | undefined>) {
  console.log(JSON.stringify({ event: `interview-prep.${label}`, ...fields }));
}

function logCacheUsage(label: string, usage: Anthropic.Messages.Usage | undefined) {
  if (!usage) return;
  console.log(
    `[interview-prep:${label}] cache_read=${usage.cache_read_input_tokens ?? 0} ` +
      `cache_write=${usage.cache_creation_input_tokens ?? 0} ` +
      `input=${usage.input_tokens} output=${usage.output_tokens}`,
  );
}

/**
 * Optional preferred-question block (sprint F6b). Emits nothing at all when no
 * bank is supplied, so the prompt stays byte-identical to before this feature —
 * existing sessions keep their cached prefix.
 *
 * Capped so a long bank can't crowd out the CV/JD or blow the cache-prefix size.
 */
function buildQuestionBankBlock(questionBank?: string[]): string {
  const questions = (questionBank ?? [])
    .map((q) => String(q).trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 20);
  if (questions.length === 0) return '';

  return `
=== PREFERRED QUESTIONS ===
Draw your questions from this list first, choosing whichever fits the conversation
next and rephrasing it naturally in your own voice. Follow-ups to the candidate's
answers still take priority — never abandon a thread just to reach the next item.
Once the list is exhausted, continue with your own questions as usual.
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}
`;
}

function buildContextPreamble(context: InterviewContext): string {
  const cvText = context.cvText.slice(0, 12000);
  return `
=== JOB BEING INTERVIEWED FOR ===
Title: ${context.jobTitle}
Company: ${context.companyName}${context.companyUrl ? ` (${context.companyUrl})` : ''}
Job Description (requirements, responsibilities — NOT claims the candidate made):
"""
${context.jobDescription}
"""

=== CANDIDATE'S CV (the ONLY source of claims the candidate has actually made) ===
"""
${cvText}
"""
${context.extraLinks?.length ? `\nAdditional candidate links:\n${context.extraLinks.map((u) => `- ${u}`).join('\n')}\n` : ''}${buildQuestionBankBlock(context.questionBank)}
=== RULES FOR YOUR QUESTIONS ===
1. Tailor questions to the job above, but base any reference to "what the candidate said/wrote/claims" ONLY on the CV section — never on the Job Description.
2. Do NOT paraphrase, quote, or attribute Job Description text to the candidate. The JD is the role's requirements, not the candidate's statements.
3. If the CV does not mention a specific skill, project, or metric that the JD asks for, you may ask the candidate to explain how they would meet that requirement — but phrase it as a gap to explore, not as a claim to challenge.
4. Only challenge or "dig into" claims that actually appear verbatim or clearly in the CV section.
5. Ask one question at a time.`;
}

export async function startInterviewSession(body: StartSessionBody, userId: string): Promise<StartSessionResponse> {
  const totalStartedAt = performance.now();
  const persona = getPersona(body.personaId);
  if (!persona) {
    throw Object.assign(new Error('Invalid persona'), { statusCode: 400 });
  }

  assertLlmConfigured('interviewPrep');
  const anthropic = createAnthropicClient('interviewPrep');
  const model = getFeatureModel('interviewPrep');

  const contextPreamble = body.context ? buildContextPreamble(body.context) : '';
  const systemPrompt = persona.systemPrompt + (contextPreamble ? `\n\n${contextPreamble}` : '');

  const openingPromise = measured(() =>
    anthropic.messages.create({
      model,
      max_tokens: 256,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: CACHE_CONTROL_1H,
        },
      ],
      messages: [
        {
          role: 'user',
          content:
            'Please begin the interview with your opening question. Just ask the first question — no preamble.',
        },
      ],
    }),
  );
  const dbSessionPromise = measured(() => dbStartSession(userId, body.personaId, body.context));

  let openingResult: Awaited<typeof openingPromise>;
  let dbSessionResult: Awaited<typeof dbSessionPromise>;
  try {
    [openingResult, dbSessionResult] = await Promise.all([openingPromise, dbSessionPromise]);
  } catch (error) {
    // If persistence won the race but generation failed, do not leave a session
    // that appears active in history.
    const dbResult = await dbSessionPromise.catch(() => null);
    if (dbResult?.value) await dbUpdateSessionStatus(dbResult.value.id, 'failed');
    throw error;
  }

  const response = openingResult.value;
  logCacheUsage('start', response.usage);

  const block = response.content.find((b) => b.type === 'text');
  const openingQuestion = block && block.type === 'text' ? block.text : 'Tell me about yourself.';

  const clientSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const dbSession = dbSessionResult.value;
  const dbSessionId = dbSession?.id;
  let questionId: string | undefined;
  let questionWriteMs = 0;
  if (dbSessionId) {
    const storedQuestion = await measured(() => dbStoreQuestion(dbSessionId, openingQuestion));
    questionId = storedQuestion.value?.id;
    questionWriteMs = storedQuestion.durationMs;
  }

  logLatency('start', {
    totalMs: Math.round(performance.now() - totalStartedAt),
    llmMs: openingResult.durationMs,
    sessionDbMs: dbSessionResult.durationMs,
    questionDbMs: questionWriteMs,
    systemChars: systemPrompt.length,
    model,
    persisted: Boolean(dbSessionId),
  });

  return { sessionId: clientSessionId, openingQuestion, dbSessionId, questionId };
}

function sessionNotFound(): Error {
  return Object.assign(new Error('Interview session not found'), { statusCode: 404 });
}

export async function sendInterviewMessage(body: SendMessageBody, userId: string | undefined): Promise<SendMessageResponse> {
  const totalStartedAt = performance.now();
  const persona = getPersona(body.personaId);
  if (!persona) {
    throw Object.assign(new Error('Invalid persona'), { statusCode: 400 });
  }

  const lastQuestion =
    body.messageHistory.filter((m) => m.role === 'interviewer').slice(-1)[0]?.content ?? '';
  const questionValidationPromise = body.dbSessionId && body.questionId
    ? dbQuestionBelongsToSession(body.dbSessionId, body.questionId)
    : Promise.resolve(null);
  // Started now, checked before anything is written (same as the question check).
  const ownerCheckPromise = body.dbSessionId ? dbSessionBelongsToUser(body.dbSessionId, userId) : Promise.resolve(true);

  assertLlmConfigured('interviewPrep');
  const anthropic = createAnthropicClient('interviewPrep');
  const model = getFeatureModel('interviewPrep');

  const contextPreamble = body.context ? buildContextPreamble(body.context) : '';
  const systemPrompt = persona.systemPrompt + (contextPreamble ? `\n\n${contextPreamble}` : '');

  const claudeMessages: Anthropic.Messages.MessageParam[] = body.messageHistory.map((m) => ({
    role: m.role === 'interviewer' ? ('assistant' as const) : ('user' as const),
    content: m.content,
  }));
  claudeMessages.push({ role: 'user', content: body.content });

  // Place a cache_control breakpoint on the last assistant message (multi-turn caching).
  // Each subsequent turn will read the cached conversation prefix instead of replaying it.
  for (let i = claudeMessages.length - 1; i >= 0; i--) {
    if (claudeMessages[i].role === 'assistant') {
      const text = typeof claudeMessages[i].content === 'string'
        ? (claudeMessages[i].content as string)
        : '';
      claudeMessages[i] = {
        role: 'assistant',
        content: [{ type: 'text', text, cache_control: CACHE_CONTROL_1H }],
      };
      break;
    }
  }

  const candidateTurnCount =
    body.messageHistory.filter((m) => m.role === 'candidate').length + 1;
  const isLastTurn = candidateTurnCount >= 5;

  const systemAddendum = isLastTurn
    ? `\n\n[IMPORTANT: This is the final exchange. Ask one brief follow-up if needed, then thank the candidate and professionally conclude the interview. End with a clear closing statement.]`
    : '';

  // Split system into a cached static prefix + an uncached addendum so the cache survives the last turn.
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: CACHE_CONTROL_1H },
  ];
  if (systemAddendum) {
    systemBlocks.push({ type: 'text', text: systemAddendum });
  }

  // Scoring and reply generation use the same input turn but do not depend on
  // one another. Starting them together removes a full LLM round-trip from the
  // user-visible waterfall.
  const [scoreResult, replyResult] = await Promise.all([
    measured(() => scoreAnswer(lastQuestion, body.content, body.context)),
    measured(() =>
      anthropic.messages.create({
        model,
        max_tokens: 300,
        system: systemBlocks,
        messages: claudeMessages,
      }),
    ),
  ]);
  const irsScore = scoreResult.value;
  const replyResponse = replyResult.value;
  logCacheUsage('turn', replyResponse.usage);

  const replyBlock = replyResponse.content.find((b) => b.type === 'text');
  const reply = replyBlock && replyBlock.type === 'text' ? replyBlock.text : 'Thank you for sharing that.';

  let assessmentId: string | undefined;
  let nextQuestionId: string | undefined;
  let persistenceMs = 0;
  if (body.dbSessionId) {
    const persistenceStartedAt = performance.now();
    // Old clients do not send questionId. Retain their behavior during rollout,
    // while new clients reuse the already-persisted question row.
    let currentQuestionId = body.questionId;
    if (!(await ownerCheckPromise)) throw sessionNotFound();
    const questionIsValid = await questionValidationPromise;
    if (currentQuestionId && questionIsValid === false) {
      throw Object.assign(new Error('Question does not belong to this interview session'), {
        statusCode: 400,
      });
    }
    if (!currentQuestionId) {
      currentQuestionId = (await dbStoreQuestion(body.dbSessionId, lastQuestion))?.id;
    }

    const assessmentPromise = currentQuestionId
      ? dbStoreAssessment(body.dbSessionId, currentQuestionId, body.content, irsScore)
      : Promise.resolve(null);
    const nextQuestionPromise = !isLastTurn
      ? dbStoreQuestion(body.dbSessionId, reply)
      : Promise.resolve(null);
    const [storedAssessment, storedNextQuestion] = await Promise.all([
      assessmentPromise,
      nextQuestionPromise,
    ]);
    assessmentId = storedAssessment?.id;
    nextQuestionId = storedNextQuestion?.id;
    persistenceMs = Math.round(performance.now() - persistenceStartedAt);
  }

  logLatency('turn', {
    totalMs: Math.round(performance.now() - totalStartedAt),
    scoreLlmMs: scoreResult.durationMs,
    replyLlmMs: replyResult.durationMs,
    persistenceMs,
    systemChars: systemPrompt.length,
    historyChars: body.messageHistory.reduce((sum, message) => sum + message.content.length, 0),
    historyMessages: body.messageHistory.length,
    answerChars: body.content.length,
    model,
    persisted: Boolean(assessmentId),
  });

  return { reply, irsScore, isComplete: isLastTurn, assessmentId, nextQuestionId };
}

export async function evaluateInterview(
  body: EvaluateSessionBody,
  userId: string | undefined,
): Promise<{ report: FeedbackReport }> {
  const totalStartedAt = performance.now();
  if (!body.session || !body.session.messages || body.session.messages.length === 0) {
    throw Object.assign(new Error('Invalid session data'), { statusCode: 400 });
  }
  if (body.dbSessionId && !(await dbSessionBelongsToUser(body.dbSessionId, userId))) throw sessionNotFound();
  let statusDbMs = 0;
  if (body.dbSessionId) {
    const statusWrite = await measured(() => dbUpdateSessionStatus(body.dbSessionId!, 'evaluating'));
    statusDbMs = statusWrite.durationMs;
  }
  const reportResult = await measured(() => generateFeedbackReport(body.session));
  const report = reportResult.value;
  let completionDbMs = 0;
  if (body.dbSessionId) {
    const completionWrite = await measured(() =>
      dbCompleteSession(body.dbSessionId!, report.overallIRS, report),
    );
    completionDbMs = completionWrite.durationMs;
  }
  logLatency('evaluate', {
    totalMs: Math.round(performance.now() - totalStartedAt),
    feedbackLlmMs: reportResult.durationMs,
    statusDbMs,
    completionDbMs,
    transcriptMessages: body.session.messages.length,
  });
  return { report };
}
