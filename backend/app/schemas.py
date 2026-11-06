from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class SessionCreate(BaseModel):
    title: str = Field(default="Untitled session", min_length=1, max_length=200)
    mode: str = Field(default="meeting", pattern="^(meeting|interview)$")


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    mode: str
    status: str
    created_at: datetime
    ended_at: datetime | None


class TranscriptSegmentOut(BaseModel):
    id: str
    session_id: str
    text: str
    source: str
    start_time: float
    end_time: float
    language: str | None
    is_final: bool
    created_at: datetime


class AIRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)


class AIResponse(BaseModel):
    response: str


class CommitmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    source_session_id: str
    source_session_title: str
    source_session_date: datetime
    person: str | None
    task: str
    due_date_text: str | None
    due_date: date | None
    source_quote: str
    status: str
    completed_in_session_id: str | None
    completion_evidence: str | None
    created_at: datetime
    completed_at: datetime | None


class CommitmentStatusUpdate(BaseModel):
    status: str = Field(pattern="^(pending|completed)$")


class CommitmentQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=4000)


class CommitmentQuestionResponse(BaseModel):
    response: str


class CommitmentScanResponse(BaseModel):
    processed: bool
    created: int
    completed: int
    already_processed: bool


class UnscannedSessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    created_at: datetime


class ConversationStatementOut(BaseModel):
    id: str
    topic: str
    statement: str
    source_quote: str
    is_commitment: bool
    meeting_title: str
    meeting_date: datetime


class ConversationContradictionOut(BaseModel):
    id: str
    topic: str
    previous_statement: ConversationStatementOut
    latest_statement: ConversationStatementOut
    explanation: str
    changes_commitment: bool
    flagged_at: datetime


class ContradictionScanResponse(BaseModel):
    processed: bool
    statements_found: int
    contradictions_found: int
    already_processed: bool


class HealthOut(BaseModel):
    status: str
    app: str
    speech: str
    inference: str
