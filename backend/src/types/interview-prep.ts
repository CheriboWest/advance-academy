import type {
  FeedbackReport,
  InterviewContext,
  IRSScore,
  PersonaId,
} from '@advance-academy/contracts/interview-prep';

export type {
  ExtractedJob,
  FeedbackItem,
  FeedbackReport,
  InterviewContext,
  InterviewerPersona,
  IRSScore,
  IRSScorePart,
  PersonaId,
} from '@advance-academy/contracts/interview-prep';

export interface InterviewMessage {
  id: string;
  role: 'interviewer' | 'candidate';
  content: string;
  timestamp: number;
  irsScore?: IRSScore;
}

export interface InterviewSession {
  id: string;
  personaId: PersonaId;
  status: 'active' | 'evaluating' | 'complete';
  startedAt: number;
  endedAt?: number;
  messages: InterviewMessage[];
  context: InterviewContext;
  finalReport?: FeedbackReport;
}

export interface StartSessionBody {
  action: 'start';
  personaId: PersonaId;
  context: InterviewContext;
}

export interface SendMessageBody {
  action: 'message';
  sessionId: string;
  content: string;
  messageHistory: Array<{ role: 'interviewer' | 'candidate'; content: string }>;
  personaId: PersonaId;
  context: InterviewContext;
  dbSessionId?: string;
  questionId?: string;
}

export interface StartSessionResponse {
  sessionId: string;
  openingQuestion: string;
  dbSessionId?: string;
  questionId?: string;
}

export interface SendMessageResponse {
  reply: string;
  irsScore: IRSScore;
  isComplete: boolean;
  assessmentId?: string;
  nextQuestionId?: string;
}

export interface EvaluateSessionBody {
  session: InterviewSession;
  dbSessionId?: string;
}
