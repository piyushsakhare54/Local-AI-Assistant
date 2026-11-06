import asyncio
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.database import engine, get_session, initialize_database
from app.models import (
    Commitment,
    CommitmentExtraction,
    ContradictionExtraction,
    ConversationContradiction,
    ConversationStatement,
    SessionRecord,
    TopicExtraction,
    TranscriptSegment,
    now_utc,
)
from app.schemas import (
    AIRequest,
    AIResponse,
    CommitmentOut,
    CommitmentQuestion,
    CommitmentQuestionResponse,
    CommitmentScanResponse,
    CommitmentStatusUpdate,
    ContradictionScanResponse,
    ConversationContradictionOut,
    ExplainRequest,
    HealthOut,
    LiveAIRequest,
    LiveAIResponse,
    LiveTranscriptSegmentOut,
    ScreenAnalysisRequest,
    SessionCreate,
    SessionOut,
    SessionTopicOut,
    SessionTopicsOut,
    TranscriptSegmentOut,
    UnscannedSessionOut,
)
from app.services.commitments import extract_commitments
from app.services.contradictions import extract_contradictions
from app.services.local_ai import (
    LocalAIError,
    ai_status,
    analyze_screen_image,
    answer_commitment_question,
    answer_live_question,
    answer_question,
    explain_technical_text,
    vision_status,
)
from app.services.topic_detection import TopicTranscriptSegment, detect_topics
from app.services.transcription import TranscriptionError, speech_status, transcribe_audio

MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_LIVE_AUDIO_BYTES = 5 * 1024 * 1024


@asynccontextmanager
async def lifespan(_: FastAPI):
    await initialize_database()
    yield
    await engine.dispose()


app = FastAPI(title="Local AI Conversation Assistant", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "null"],
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health", response_model=HealthOut)
async def health() -> HealthOut:
    return HealthOut(
        status="ok",
        app="ready",
        speech=speech_status(),
        inference=await ai_status(),
        vision=await vision_status(),
    )


@app.get("/api/sessions", response_model=list[SessionOut])
async def list_sessions(db: Annotated[AsyncSession, Depends(get_session)]) -> list[SessionRecord]:
    result = await db.scalars(select(SessionRecord).order_by(SessionRecord.created_at.desc()))
    return list(result)


@app.post("/api/sessions", response_model=SessionOut, status_code=201)
async def create_session(
    payload: SessionCreate, db: Annotated[AsyncSession, Depends(get_session)]
) -> SessionRecord:
    record = SessionRecord(title=payload.title.strip(), mode=payload.mode)
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return record


@app.get(
    "/api/sessions/{session_id}/transcript",
    response_model=list[TranscriptSegmentOut],
)
async def get_transcript(
    session_id: str, db: Annotated[AsyncSession, Depends(get_session)]
) -> list[TranscriptSegment]:
    if await db.get(SessionRecord, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    result = await db.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.session_id == session_id)
        .order_by(TranscriptSegment.start_time, TranscriptSegment.created_at)
    )
    return list(result)


@app.post(
    "/api/sessions/{session_id}/transcribe",
    response_model=list[TranscriptSegmentOut],
)
async def transcribe_session(
    session_id: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> list[TranscriptSegment]:
    if await db.get(SessionRecord, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
            if length < 0:
                raise ValueError
            if length > MAX_AUDIO_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail={
                        "code": "audio_too_large",
                        "message": "Audio must be smaller than 25 MB.",
                    },
                )
        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_content_length", "message": "Invalid audio size."},
            ) from error

    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > MAX_AUDIO_BYTES:
            raise HTTPException(
                status_code=413,
                detail={"code": "audio_too_large", "message": "Audio must be smaller than 25 MB."},
            )
        content.extend(chunk)
    if not content:
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_audio", "message": "No audio was captured."},
        )
    try:
        segments = await asyncio.to_thread(transcribe_audio, bytes(content))
    except TranscriptionError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error

    records = [
        TranscriptSegment(
            session_id=session_id,
            text=segment.text,
            source="microphone",
            start_time=segment.start_time,
            end_time=segment.end_time,
            language=segment.language,
            is_final=True,
        )
        for segment in segments
    ]
    if records:
        topic_extraction = await db.get(TopicExtraction, session_id)
        if topic_extraction is not None:
            await db.delete(topic_extraction)
    db.add_all(records)
    await db.commit()
    for record in records:
        await db.refresh(record)
    return records


@app.post(
    "/api/sessions/{session_id}/live-transcribe",
    response_model=list[LiveTranscriptSegmentOut],
)
async def transcribe_live_audio(
    session_id: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_session)],
    offset_seconds: Annotated[float, Query(ge=0, le=86400)] = 0,
    unique_from_seconds: Annotated[float, Query(ge=0, le=86400)] = 0,
) -> list[LiveTranscriptSegmentOut]:
    if await db.get(SessionRecord, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if unique_from_seconds > offset_seconds:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_audio_offset",
                "message": "The unique audio offset cannot be later than the chunk offset.",
            },
        )
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > MAX_LIVE_AUDIO_BYTES:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "live_audio_too_large",
                    "message": "A live audio chunk must be smaller than 5 MB.",
                },
            )
        content.extend(chunk)
    if not content:
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_audio", "message": "No live audio was captured."},
        )
    try:
        segments = await asyncio.to_thread(transcribe_audio, bytes(content))
    except TranscriptionError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error

    existing_result = await db.scalars(
        select(TranscriptSegment).where(
            TranscriptSegment.session_id == session_id,
            TranscriptSegment.start_time >= max(0, offset_seconds - 2),
            TranscriptSegment.start_time <= offset_seconds + 7,
        )
    )
    existing_segments = list(existing_result)
    records: list[TranscriptSegment] = []
    for segment in segments:
        start_time = offset_seconds + segment.start_time
        if start_time < unique_from_seconds:
            continue
        text_key = _transcript_text_key(segment.text)
        if any(
            _transcript_text_key(existing.text) == text_key
            and abs(existing.start_time - start_time) < 2
            for existing in [*existing_segments, *records]
        ):
            continue
        records.append(
            TranscriptSegment(
                session_id=session_id,
                text=segment.text,
                source="microphone",
                start_time=start_time,
                end_time=offset_seconds + segment.end_time,
                language=segment.language,
                is_final=True,
            )
        )
    db.add_all(records)
    if records:
        topic_extraction = await db.get(TopicExtraction, session_id)
        if topic_extraction is not None:
            await db.delete(topic_extraction)
        await db.commit()
        for record in records:
            await db.refresh(record)
    return [
        LiveTranscriptSegmentOut(
            id=record.id,
            text=record.text,
            start_time=record.start_time,
            end_time=record.end_time,
            language=record.language,
        )
        for record in records
    ]


def _transcript_text_key(text: str) -> str:
    return " ".join(text.casefold().split()).strip(" .,!?;:")


@app.post(
    "/api/sessions/{session_id}/live-answer",
    response_model=LiveAIResponse,
)
async def answer_live_session(
    session_id: str,
    payload: LiveAIRequest,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> LiveAIResponse:
    if await db.get(SessionRecord, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        answered, response = await answer_live_question(
            payload.transcript,
            question=payload.question,
            auto_answer=payload.auto_answer,
        )
    except LocalAIError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error
    return LiveAIResponse(answered=answered, response=response)


@app.post(
    "/api/sessions/{session_id}/analyze-screen",
    response_model=AIResponse,
)
async def analyze_session_screen(
    session_id: str,
    payload: ScreenAnalysisRequest,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> AIResponse:
    if await db.get(SessionRecord, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        response = await analyze_screen_image(
            payload.image_base64,
            question=payload.question,
            transcript=payload.transcript,
        )
    except LocalAIError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error
    return AIResponse(response=response)


@app.post(
    "/api/sessions/{session_id}/topics",
    response_model=SessionTopicsOut,
)
async def get_session_topics(
    session_id: str,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> SessionTopicsOut:
    if await db.get(SessionRecord, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    extraction = await db.get(TopicExtraction, session_id)
    if extraction is not None:
        try:
            return SessionTopicsOut.model_validate_json(extraction.topics_json)
        except ValueError as error:
            raise HTTPException(
                status_code=500,
                detail={
                    "code": "topic_cache_invalid",
                    "message": "Saved topic sections could not be read. Contact support.",
                },
            ) from error

    result = await db.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.session_id == session_id)
        .order_by(TranscriptSegment.start_time, TranscriptSegment.created_at)
    )
    segments = list(result)
    try:
        detected_topics = await detect_topics(
            [
                TopicTranscriptSegment(
                    id=segment.id,
                    text=segment.text,
                    start_time=segment.start_time,
                    end_time=segment.end_time,
                )
                for segment in segments
            ]
        )
    except LocalAIError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error

    topics = [
        SessionTopicOut(
            title=topic.title,
            summary=topic.summary,
            start_time=segments[topic.start_segment_index].start_time,
            end_time=segments[topic.end_segment_index].end_time,
            start_segment_id=segments[topic.start_segment_index].id,
            end_segment_id=segments[topic.end_segment_index].id,
        )
        for topic in detected_topics
    ]
    extraction = TopicExtraction(
        session_id=session_id,
        topics_json=SessionTopicsOut(topics=topics).model_dump_json(),
    )
    db.add(extraction)
    await db.commit()
    return SessionTopicsOut(topics=topics)


@app.post("/api/sessions/{session_id}/ask", response_model=AIResponse)
async def ask_about_session(
    session_id: str,
    payload: AIRequest,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> AIResponse:
    if await db.get(SessionRecord, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    result = await db.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.session_id == session_id)
        .order_by(TranscriptSegment.start_time, TranscriptSegment.created_at)
    )
    transcript = "\n".join(segment.text for segment in result)
    try:
        response = await answer_question(transcript, payload.question)
    except LocalAIError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error
    return AIResponse(response=response)


@app.post("/api/sessions/{session_id}/explain", response_model=AIResponse)
async def explain_session_text(
    session_id: str,
    payload: ExplainRequest,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> AIResponse:
    if await db.get(SessionRecord, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        response = await explain_technical_text(payload.text)
    except LocalAIError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error
    return AIResponse(response=response)


@app.get("/api/commitments", response_model=list[CommitmentOut])
async def list_commitments(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> list[dict[str, object]]:
    result = await db.execute(
        select(Commitment, SessionRecord)
        .join(SessionRecord, Commitment.source_session_id == SessionRecord.id)
        .order_by(Commitment.created_at.desc())
    )
    return [_commitment_payload(commitment, meeting) for commitment, meeting in result]


@app.get("/api/commitments/unscanned", response_model=list[UnscannedSessionOut])
async def list_unscanned_sessions(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> list[SessionRecord]:
    result = await db.scalars(
        select(SessionRecord)
        .where(
            exists().where(TranscriptSegment.session_id == SessionRecord.id),
            ~exists().where(CommitmentExtraction.session_id == SessionRecord.id),
        )
        .order_by(SessionRecord.created_at.asc())
    )
    return list(result)


@app.post("/api/commitments/scan/{session_id}", response_model=CommitmentScanResponse)
async def scan_session_commitments(
    session_id: str,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> CommitmentScanResponse:
    meeting = await db.get(SessionRecord, session_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if await db.get(CommitmentExtraction, session_id) is not None:
        return CommitmentScanResponse(
            processed=True, created=0, completed=0, already_processed=True
        )

    segments = await db.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.session_id == session_id)
        .order_by(TranscriptSegment.start_time, TranscriptSegment.created_at)
    )
    transcript = "\n".join(segment.text for segment in segments)
    if not transcript.strip():
        raise HTTPException(
            status_code=400,
            detail={
                "code": "transcript_empty",
                "message": "This session has no transcript to scan.",
            },
        )

    pending_result = await db.scalars(
        select(Commitment)
        .join(SessionRecord, Commitment.source_session_id == SessionRecord.id)
        .where(
            Commitment.status == "pending",
            SessionRecord.created_at < meeting.created_at,
        )
        .order_by(Commitment.created_at.desc())
    )
    pending = list(pending_result)
    pending_context = [
        {
            "id": item.id,
            "person": item.person,
            "task": item.task,
            "due_date_text": item.due_date_text,
        }
        for item in pending
    ]
    try:
        extracted = await extract_commitments(
            transcript=transcript,
            meeting_title=meeting.title,
            meeting_date=meeting.created_at.date(),
            pending_commitments=pending_context,
        )
    except LocalAIError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error

    current_pending = {item["id"] for item in pending_context}
    for item in extracted.commitments:
        db.add(
            Commitment(
                id=str(uuid4()),
                source_session_id=session_id,
                person=item.person,
                task=item.task,
                due_date_text=item.due_date_text,
                due_date=item.due_date,
                source_quote=item.source_quote,
                status="pending",
            )
        )

    completed_count = 0
    for item in extracted.completed:
        if item.commitment_id not in current_pending:
            continue
        commitment = await db.get(Commitment, item.commitment_id)
        if commitment is None or commitment.status != "pending":
            continue
        commitment.status = "completed"
        commitment.completed_in_session_id = session_id
        commitment.completion_evidence = item.evidence
        commitment.completed_at = now_utc()
        completed_count += 1

    db.add(CommitmentExtraction(session_id=session_id, processed_at=now_utc()))
    await db.commit()
    return CommitmentScanResponse(
        processed=True,
        created=len(extracted.commitments),
        completed=completed_count,
        already_processed=False,
    )


@app.patch("/api/commitments/{commitment_id}", response_model=CommitmentOut)
async def update_commitment_status(
    commitment_id: str,
    payload: CommitmentStatusUpdate,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, object]:
    commitment = await db.get(Commitment, commitment_id)
    if commitment is None:
        raise HTTPException(status_code=404, detail="Commitment not found")
    commitment.status = payload.status
    if payload.status == "completed":
        commitment.completed_at = now_utc()
    else:
        commitment.completed_at = None
        commitment.completed_in_session_id = None
        commitment.completion_evidence = None
    await db.commit()
    meeting = await db.get(SessionRecord, commitment.source_session_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Source meeting not found")
    return _commitment_payload(commitment, meeting)


@app.post("/api/commitments/ask", response_model=CommitmentQuestionResponse)
async def ask_about_commitments(
    payload: CommitmentQuestion,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> CommitmentQuestionResponse:
    result = await db.execute(
        select(Commitment, SessionRecord)
        .join(SessionRecord, Commitment.source_session_id == SessionRecord.id)
        .order_by(Commitment.created_at.desc())
    )
    context_lines = [
        (
            f"- id={item.id}; status={item.status}; person={item.person or 'not identified'}; "
            f"commitment={item.task}; "
            f"due={item.due_date_text or item.due_date or 'not specified'}; "
            f"meeting={meeting.title} ({meeting.created_at.date().isoformat()})"
        )
        for item, meeting in result
    ]
    try:
        response = await answer_commitment_question("\n".join(context_lines), payload.question)
    except LocalAIError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error
    return CommitmentQuestionResponse(response=response)


@app.get(
    "/api/contradictions",
    response_model=list[ConversationContradictionOut],
)
async def list_contradictions(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> list[dict[str, object]]:
    previous_statement = aliased(ConversationStatement)
    latest_statement = aliased(ConversationStatement)
    previous_meeting = aliased(SessionRecord)
    latest_meeting = aliased(SessionRecord)
    result = await db.execute(
        select(
            ConversationContradiction,
            previous_statement,
            previous_meeting,
            latest_statement,
            latest_meeting,
        )
        .join(
            previous_statement,
            ConversationContradiction.previous_statement_id == previous_statement.id,
        )
        .join(
            previous_meeting,
            previous_statement.source_session_id == previous_meeting.id,
        )
        .join(
            latest_statement,
            ConversationContradiction.latest_statement_id == latest_statement.id,
        )
        .join(
            latest_meeting,
            latest_statement.source_session_id == latest_meeting.id,
        )
        .order_by(ConversationContradiction.created_at.desc())
    )
    return [
        _contradiction_payload(
            contradiction,
            previous,
            previous_session,
            latest,
            latest_session,
        )
        for contradiction, previous, previous_session, latest, latest_session in result
    ]


@app.get("/api/contradictions/unscanned", response_model=list[UnscannedSessionOut])
async def list_unscanned_contradiction_sessions(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> list[SessionRecord]:
    result = await db.scalars(
        select(SessionRecord)
        .where(
            exists().where(TranscriptSegment.session_id == SessionRecord.id),
            ~exists().where(ContradictionExtraction.session_id == SessionRecord.id),
        )
        .order_by(SessionRecord.created_at.asc())
    )
    return list(result)


@app.post(
    "/api/contradictions/scan/{session_id}",
    response_model=ContradictionScanResponse,
)
async def scan_session_contradictions(
    session_id: str,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> ContradictionScanResponse:
    meeting = await db.get(SessionRecord, session_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if await db.get(ContradictionExtraction, session_id) is not None:
        return ContradictionScanResponse(
            processed=True,
            statements_found=0,
            contradictions_found=0,
            already_processed=True,
        )

    segments = await db.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.session_id == session_id)
        .order_by(TranscriptSegment.start_time, TranscriptSegment.created_at)
    )
    transcript = "\n".join(segment.text for segment in segments)
    if not transcript.strip():
        raise HTTPException(
            status_code=400,
            detail={
                "code": "transcript_empty",
                "message": "This session has no transcript to analyze.",
            },
        )

    earlier = await db.execute(
        select(ConversationStatement, SessionRecord)
        .join(
            SessionRecord,
            ConversationStatement.source_session_id == SessionRecord.id,
        )
        .where(SessionRecord.created_at < meeting.created_at)
        .order_by(SessionRecord.created_at.asc(), ConversationStatement.created_at.asc())
    )
    previous_statements = [
        {
            "id": statement.id,
            "topic": statement.topic,
            "statement": statement.statement,
            "source_quote": statement.source_quote,
            "is_commitment": statement.is_commitment,
            "meeting_title": earlier_meeting.title,
            "meeting_date": earlier_meeting.created_at.date().isoformat(),
        }
        for statement, earlier_meeting in earlier
    ]
    try:
        extracted = await extract_contradictions(
            transcript=transcript,
            meeting_title=meeting.title,
            meeting_date=meeting.created_at.date().isoformat(),
            previous_statements=previous_statements,
        )
    except LocalAIError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error

    statements_by_quote: dict[str, ConversationStatement] = {}
    for item in extracted.statements:
        statement = ConversationStatement(
            id=str(uuid4()),
            source_session_id=session_id,
            topic=item.topic,
            statement=item.source_quote,
            source_quote=item.source_quote,
            is_commitment=item.is_commitment,
            created_at=meeting.created_at,
        )
        db.add(statement)
        statements_by_quote.setdefault(item.source_quote, statement)
    await db.flush()

    previous_by_id = {str(item["id"]): item for item in previous_statements}
    for item in extracted.contradictions:
        earlier_statement = await db.get(ConversationStatement, item.previous_statement_id)
        latest_statement = statements_by_quote[item.latest_source_quote]
        if earlier_statement is None or latest_statement.source_session_id != session_id:
            continue
        previous_info = previous_by_id[item.previous_statement_id]
        db.add(
            ConversationContradiction(
                previous_statement_id=earlier_statement.id,
                latest_statement_id=latest_statement.id,
                explanation=item.explanation,
                changes_commitment=bool(previous_info["is_commitment"]),
                created_at=meeting.created_at,
            )
        )

    db.add(ContradictionExtraction(session_id=session_id, processed_at=now_utc()))
    await db.commit()
    return ContradictionScanResponse(
        processed=True,
        statements_found=len(extracted.statements),
        contradictions_found=len(extracted.contradictions),
        already_processed=False,
    )


@app.post("/api/sessions/{session_id}/end", response_model=SessionOut)
async def end_session(
    session_id: str, db: Annotated[AsyncSession, Depends(get_session)]
) -> SessionRecord:
    record = await db.get(SessionRecord, session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Session not found")
    record.status = "ended"
    record.ended_at = now_utc()
    await db.commit()
    await db.refresh(record)
    return record


def _commitment_payload(
    commitment: Commitment, meeting: SessionRecord
) -> dict[str, object]:
    return {
        "id": commitment.id,
        "source_session_id": commitment.source_session_id,
        "source_session_title": meeting.title,
        "source_session_date": meeting.created_at,
        "person": commitment.person,
        "task": commitment.task,
        "due_date_text": commitment.due_date_text,
        "due_date": commitment.due_date,
        "source_quote": commitment.source_quote,
        "status": commitment.status,
        "completed_in_session_id": commitment.completed_in_session_id,
        "completion_evidence": commitment.completion_evidence,
        "created_at": commitment.created_at,
        "completed_at": commitment.completed_at,
    }


def _contradiction_payload(
    contradiction: ConversationContradiction,
    previous: ConversationStatement,
    previous_meeting: SessionRecord,
    latest: ConversationStatement,
    latest_meeting: SessionRecord,
) -> dict[str, object]:
    return {
        "id": contradiction.id,
        "topic": latest.topic,
        "previous_statement": _statement_payload(previous, previous_meeting),
        "latest_statement": _statement_payload(latest, latest_meeting),
        "explanation": contradiction.explanation,
        "changes_commitment": contradiction.changes_commitment,
        "flagged_at": contradiction.created_at,
    }


def _statement_payload(
    statement: ConversationStatement, meeting: SessionRecord
) -> dict[str, object]:
    return {
        "id": statement.id,
        "topic": statement.topic,
        "statement": statement.statement,
        "source_quote": statement.source_quote,
        "is_commitment": statement.is_commitment,
        "meeting_title": meeting.title,
        "meeting_date": meeting.created_at,
    }
