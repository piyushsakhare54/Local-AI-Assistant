from datetime import UTC, date, datetime
from uuid import uuid4

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def now_utc() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class SessionRecord(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    title: Mapped[str] = mapped_column(String(200), default="Untitled session")
    mode: Mapped[str] = mapped_column(String(30), default="meeting")
    status: Mapped[str] = mapped_column(String(20), default="ready")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    segments: Mapped[list["TranscriptSegment"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(30), default="microphone")
    speaker_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    start_time: Mapped[float] = mapped_column()
    end_time: Mapped[float] = mapped_column()
    language: Mapped[str | None] = mapped_column(String(20), nullable=True)
    is_final: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    session: Mapped[SessionRecord] = relationship(back_populates="segments")


class SessionNote(Base):
    __tablename__ = "session_notes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), unique=True
    )
    summary: Mapped[str] = mapped_column(Text, default="")
    decisions_json: Mapped[str] = mapped_column(Text, default="[]")
    action_items_json: Mapped[str] = mapped_column(Text, default="[]")


class Commitment(Base):
    __tablename__ = "commitments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    source_session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    person: Mapped[str | None] = mapped_column(String(120), nullable=True)
    task: Mapped[str] = mapped_column(Text)
    due_date_text: Mapped[str | None] = mapped_column(String(120), nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    source_quote: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    completed_in_session_id: Mapped[str | None] = mapped_column(
        ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True
    )
    completion_evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CommitmentExtraction(Base):
    __tablename__ = "commitment_extractions"
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ConversationStatement(Base):
    __tablename__ = "conversation_statements"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    source_session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    topic: Mapped[str] = mapped_column(String(200))
    statement: Mapped[str] = mapped_column(Text)
    source_quote: Mapped[str] = mapped_column(Text)
    is_commitment: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ConversationContradiction(Base):
    __tablename__ = "conversation_contradictions"
    __table_args__ = (
        UniqueConstraint(
            "previous_statement_id",
            "latest_statement_id",
            name="uq_contradiction_statement_pair",
        ),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    previous_statement_id: Mapped[str] = mapped_column(
        ForeignKey("conversation_statements.id", ondelete="CASCADE"), index=True
    )
    latest_statement_id: Mapped[str] = mapped_column(
        ForeignKey("conversation_statements.id", ondelete="CASCADE"), index=True
    )
    explanation: Mapped[str] = mapped_column(Text)
    changes_commitment: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ContradictionExtraction(Base):
    __tablename__ = "contradiction_extractions"
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
