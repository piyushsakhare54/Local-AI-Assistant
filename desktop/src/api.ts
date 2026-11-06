export type Health = {
  status: string;
  app: string;
  speech: string;
  inference: string;
  vision: string;
};

export type LiveTranscriptSegment = {
  id: string;
  text: string;
  start_time: number;
  end_time: number;
  language: string | null;
};

export type ScreenSource = {
  id: string;
  name: string;
  thumbnail: string;
};

export type Session = {
  id: string;
  title: string;
  mode: string;
  status: string;
  created_at: string;
  ended_at: string | null;
};

export type TranscriptSegment = {
  id: string;
  session_id: string;
  text: string;
  source: string;
  start_time: number;
  end_time: number;
  language: string | null;
  is_final: boolean;
  created_at: string;
};

export type SessionTopic = {
  title: string;
  summary: string;
  start_time: number;
  end_time: number;
  start_segment_id: string;
  end_segment_id: string;
};

export type SessionTopics = {
  topics: SessionTopic[];
};

export type Commitment = {
  id: string;
  source_session_id: string;
  source_session_title: string;
  source_session_date: string;
  person: string | null;
  task: string;
  due_date_text: string | null;
  due_date: string | null;
  source_quote: string;
  status: 'pending' | 'completed';
  completed_in_session_id: string | null;
  completion_evidence: string | null;
  created_at: string;
  completed_at: string | null;
};

export type UnscannedSession = {
  id: string;
  title: string;
  created_at: string;
};

export type ConversationStatement = {
  id: string;
  topic: string;
  statement: string;
  source_quote: string;
  is_commitment: boolean;
  meeting_title: string;
  meeting_date: string;
};

export type ConversationContradiction = {
  id: string;
  topic: string;
  previous_statement: ConversationStatement;
  latest_statement: ConversationStatement;
  explanation: string;
  changes_commitment: boolean;
  flagged_at: string;
};

declare global {
  interface Window {
    desktop?: {
      saveSummaryPdf: (
        html: string,
        fileName: string,
      ) => Promise<{ saved: boolean; filePath?: string }>;
      listScreenSources: () => Promise<ScreenSource[]>;
      captureScreen: (sourceId: string) => Promise<{ imageBase64: string }>;
    };
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const API = 'http://127.0.0.1:8765/api';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, init);
  } catch {
    throw new ApiError('Cannot reach the local service. Restart the app and try again.', 'offline');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null && 'detail' in body
      ? body.detail
      : null;
    if (typeof detail === 'object' && detail !== null && 'message' in detail) {
      const message = String(detail.message);
      const code = 'code' in detail ? String(detail.code) : 'request_failed';
      throw new ApiError(message, code);
    }
    throw new ApiError(
      typeof detail === 'string' ? detail : `The local service returned HTTP ${response.status}.`,
      'request_failed',
    );
  }
  return body as T;
}

export function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}
