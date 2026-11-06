from collections.abc import AsyncIterator
from datetime import date

import pytest
from app import main
from app.database import get_session
from app.main import app
from app.models import Base
from app.services.commitments import (
    CommitmentExtractionResult,
    CompletedCommitment,
    ExtractedCommitment,
)
from app.services.contradictions import (
    ContradictionExtractionResult,
    ExtractedContradiction,
    ExtractedStatement,
)
from app.services.local_ai import LocalAIError
from app.services.topic_detection import DetectedTopic, TopicTranscriptSegment
from app.services.transcription import TranscribedSegment
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


@pytest.fixture
async def client(tmp_path) -> AsyncIterator[AsyncClient]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://local"
        ) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_health_and_local_inference_status(client: AsyncClient) -> None:
    response = await client.get("/api/health")
    created = await client.post(
        "/api/sessions",
        json={"title": "Interview prep", "mode": "interview"},
    )
    sessions = await client.get("/api/sessions")
    assert response.status_code == 200
    assert response.json()["speech"] in {"ready", "not_configured"}
    assert response.json()["inference"] in {"ready", "model_not_installed", "runtime_unavailable"}
    assert response.json()["vision"] in {"ready", "model_not_installed", "runtime_unavailable"}
    assert created.status_code == 201
    assert created.json()["mode"] == "interview"
    assert any(row["id"] == created.json()["id"] for row in sessions.json())


async def test_transcribe_persists_local_transcript(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_transcribe(audio: bytes) -> list[TranscribedSegment]:
        assert audio == b"test audio"
        return [TranscribedSegment("Hello there.", 0.0, 1.2, "en")]

    monkeypatch.setattr(
        main,
        "transcribe_audio",
        fake_transcribe,
    )
    created = await client.post("/api/sessions", json={"title": "Voice test"})
    response = await client.post(
        f"/api/sessions/{created.json()['id']}/transcribe",
        content=b"test audio",
        headers={"Content-Type": "audio/webm"},
    )
    transcript = await client.get(f"/api/sessions/{created.json()['id']}/transcript")
    assert response.status_code == 200
    assert response.json()[0]["text"] == "Hello there."
    assert transcript.json()[0]["language"] == "en"


async def test_live_transcription_returns_segments_with_global_timestamps(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_transcribe(audio: bytes) -> list[TranscribedSegment]:
        assert audio.startswith(b"RIFF")
        return [
            TranscribedSegment("Older overlapping phrase.", 0.1, 0.4, "en"),
            TranscribedSegment("The latest phrase.", 1.2, 1.8, "en"),
        ]

    monkeypatch.setattr(main, "transcribe_audio", fake_transcribe)
    created = await client.post("/api/sessions", json={"title": "Live transcription"})
    session_id = created.json()["id"]
    response = await client.post(
        f"/api/sessions/{session_id}/live-transcribe",
        params={"offset_seconds": 5, "unique_from_seconds": 5},
        content=b"RIFF live wave audio",
        headers={"Content-Type": "audio/wav"},
    )
    saved = await client.get(f"/api/sessions/{session_id}/transcript")

    assert response.status_code == 200
    assert len(response.json()) == 2
    assert response.json()[1]["text"] == "The latest phrase."
    assert response.json()[1]["start_time"] == pytest.approx(6.2)
    assert len(saved.json()) == 2
    assert saved.json()[0]["text"] == "Older overlapping phrase."


async def test_live_transcription_deduplicates_repeated_overlap_segments(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        main,
        "transcribe_audio",
        lambda audio: [TranscribedSegment("We need to update the plan.", 0.1, 0.8, "en")],
    )
    created = await client.post("/api/sessions", json={"title": "Live overlap"})
    session_id = created.json()["id"]

    first = await client.post(
        f"/api/sessions/{session_id}/live-transcribe",
        params={"offset_seconds": 4.8, "unique_from_seconds": 4.8},
        content=b"first chunk",
    )
    second = await client.post(
        f"/api/sessions/{session_id}/live-transcribe",
        params={"offset_seconds": 5, "unique_from_seconds": 5},
        content=b"overlapping chunk",
    )
    saved = await client.get(f"/api/sessions/{session_id}/transcript")

    assert len(first.json()) == 1
    assert second.json() == []
    assert len(saved.json()) == 1


async def test_live_transcription_rejects_invalid_chunk_offsets(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main, "transcribe_audio", lambda audio: [])
    created = await client.post("/api/sessions", json={"title": "Invalid live offset"})
    response = await client.post(
        f"/api/sessions/{created.json()['id']}/live-transcribe",
        params={"offset_seconds": 5, "unique_from_seconds": 6},
        content=b"audio",
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_audio_offset"


async def test_ai_answers_questions_using_saved_transcript(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_transcribe(audio: bytes) -> list[TranscribedSegment]:
        assert audio == b"test audio"
        return [TranscribedSegment("The deadline is Friday.", 0.0, 1.2, "en")]

    monkeypatch.setattr(
        main,
        "transcribe_audio",
        fake_transcribe,
    )

    async def fake_answer(transcript: str, question: str) -> str:
        assert transcript == "The deadline is Friday."
        assert question == "When is the deadline?"
        return "The deadline is Friday."

    monkeypatch.setattr(main, "answer_question", fake_answer)
    created = await client.post("/api/sessions", json={"title": "AI test"})
    session_id = created.json()["id"]
    await client.post(
        f"/api/sessions/{session_id}/transcribe",
        content=b"test audio",
        headers={"Content-Type": "audio/webm"},
    )
    response = await client.post(
        f"/api/sessions/{session_id}/ask",
        json={"question": "When is the deadline?"},
    )
    assert response.status_code == 200
    assert response.json()["response"] == "The deadline is Friday."


async def test_explain_selected_transcript_text(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    excerpt = "implement an asynchronous event-driven ingestion pipeline"

    async def fake_explain(text: str) -> str:
        assert text == excerpt
        return "Simple explanation: build a system that processes incoming data in the background."

    monkeypatch.setattr(main, "explain_technical_text", fake_explain)
    created = await client.post("/api/sessions", json={"title": "Explain test"})
    response = await client.post(
        f"/api/sessions/{created.json()['id']}/explain",
        json={"text": excerpt},
    )

    assert response.status_code == 200
    assert response.json()["response"].startswith("Simple explanation:")


async def test_live_answer_uses_conversation_context_and_auto_answer_flag(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_answer(
        transcript: str,
        *,
        question: str | None,
        auto_answer: bool,
    ) -> tuple[bool, str]:
        assert transcript == "The deployment is blocked by missing staging secrets."
        assert question is None
        assert auto_answer is True
        return True, "Ask the platform team to configure the secrets."

    monkeypatch.setattr(main, "answer_live_question", fake_answer)
    created = await client.post("/api/sessions", json={"title": "Live answer"})
    response = await client.post(
        f"/api/sessions/{created.json()['id']}/live-answer",
        json={
            "transcript": "The deployment is blocked by missing staging secrets.",
            "auto_answer": True,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "answered": True,
        "response": "Ask the platform team to configure the secrets.",
    }


async def test_screen_analysis_is_sent_to_the_local_vision_service(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_analyze(
        image_base64: str,
        *,
        question: str,
        transcript: str,
    ) -> str:
        assert image_base64 == "c2NyZWVuc2hvdA=="
        assert question == "What is shown?"
        assert transcript == "We are reviewing the deployment plan."
        return "The screen shows the deployment plan."

    monkeypatch.setattr(main, "analyze_screen_image", fake_analyze)
    created = await client.post("/api/sessions", json={"title": "Screen analysis"})
    response = await client.post(
        f"/api/sessions/{created.json()['id']}/analyze-screen",
        json={
            "image_base64": "c2NyZWVuc2hvdA==",
            "question": "What is shown?",
            "transcript": "We are reviewing the deployment plan.",
        },
    )

    assert response.status_code == 200
    assert response.json()["response"] == "The screen shows the deployment plan."


async def test_session_topics_use_transcript_timestamps_and_are_cached(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        main,
        "transcribe_audio",
        lambda audio: [
            TranscribedSegment("We should split the application into services.", 4.0, 7.5, "en"),
            TranscribedSegment("The database query is slow.", 8.0, 10.0, "en"),
        ],
    )
    calls = 0

    async def fake_detect(
        segments: list[TopicTranscriptSegment],
    ) -> list[DetectedTopic]:
        nonlocal calls
        calls += 1
        assert [segment.text for segment in segments] == [
            "We should split the application into services.",
            "The database query is slow.",
        ]
        return [
            DetectedTopic("Project architecture", "Discussed service boundaries.", 0, 0),
            DetectedTopic("Database performance", "Identified a slow database query.", 1, 1),
        ]

    monkeypatch.setattr(main, "detect_topics", fake_detect)
    created = await client.post("/api/sessions", json={"title": "Topic test"})
    session_id = created.json()["id"]
    await client.post(
        f"/api/sessions/{session_id}/transcribe",
        content=b"audio",
        headers={"Content-Type": "audio/webm"},
    )

    response = await client.post(f"/api/sessions/{session_id}/topics")
    repeated = await client.post(f"/api/sessions/{session_id}/topics")

    assert response.status_code == 200
    assert response.json()["topics"][0]["start_time"] == 4.0
    assert response.json()["topics"][0]["end_time"] == 7.5
    assert response.json()["topics"][0]["start_segment_id"]
    assert response.json()["topics"][1]["title"] == "Database performance"
    assert repeated.json() == response.json()
    assert calls == 1


async def test_new_transcript_segments_invalidate_saved_topics(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    transcripts = iter(
        [
            [TranscribedSegment("We need a new service boundary.", 0.0, 3.0, "en")],
            [TranscribedSegment("The database query needs an index.", 5.0, 8.0, "en")],
        ]
    )
    monkeypatch.setattr(main, "transcribe_audio", lambda audio: next(transcripts))
    calls = 0

    async def fake_detect(
        segments: list[TopicTranscriptSegment],
    ) -> list[DetectedTopic]:
        nonlocal calls
        calls += 1
        return [
            DetectedTopic("Discussion", "The current discussion topic.", 0, len(segments) - 1)
        ]

    monkeypatch.setattr(main, "detect_topics", fake_detect)
    created = await client.post("/api/sessions", json={"title": "Topic refresh test"})
    session_id = created.json()["id"]
    await client.post(
        f"/api/sessions/{session_id}/transcribe",
        content=b"first",
        headers={"Content-Type": "audio/webm"},
    )
    await client.post(f"/api/sessions/{session_id}/topics")
    await client.post(
        f"/api/sessions/{session_id}/transcribe",
        content=b"second",
        headers={"Content-Type": "audio/webm"},
    )

    refreshed = await client.post(f"/api/sessions/{session_id}/topics")

    assert calls == 2
    assert refreshed.json()["topics"][0]["end_time"] == 8.0


async def test_commitments_scan_history_status_and_cross_meeting_question(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        main,
        "transcribe_audio",
        lambda audio: [
            TranscribedSegment("I will share the API documentation Friday.", 0, 1, "en")
        ],
    )
    created = await client.post("/api/sessions", json={"title": "Planning meeting"})
    session_id = created.json()["id"]
    await client.post(
        f"/api/sessions/{session_id}/transcribe",
        content=b"audio",
        headers={"Content-Type": "audio/webm"},
    )

    async def fake_extract(
        *,
        transcript: str,
        meeting_title: str,
        meeting_date: date,
        pending_commitments: list[dict[str, str | None]],
    ) -> CommitmentExtractionResult:
        assert transcript == "I will share the API documentation Friday."
        assert meeting_title == "Planning meeting"
        assert not pending_commitments
        return CommitmentExtractionResult(
            commitments=[
                ExtractedCommitment(
                    person=None,
                    task="Share the API documentation",
                    due_date_text="Friday",
                    due_date=None,
                    source_quote="I will share the API documentation Friday.",
                )
            ],
            completed=[],
        )

    monkeypatch.setattr(main, "extract_commitments", fake_extract)
    scanned = await client.post(f"/api/commitments/scan/{session_id}")
    rows = await client.get("/api/commitments")
    backlog = await client.get("/api/commitments/unscanned")
    assert scanned.status_code == 200
    assert scanned.json()["created"] == 1
    assert rows.status_code == 200
    assert rows.json()[0]["task"] == "Share the API documentation"
    assert rows.json()[0]["person"] is None
    assert backlog.json() == []

    commitment_id = rows.json()[0]["id"]
    updated = await client.patch(
        f"/api/commitments/{commitment_id}",
        json={"status": "completed"},
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "completed"

    async def fake_answer(context: str, question: str) -> str:
        assert "Share the API documentation" in context
        assert "status=completed" in context
        assert question == "What was promised?"
        return "The API documentation was promised."

    monkeypatch.setattr(main, "answer_commitment_question", fake_answer)
    answer = await client.post(
        "/api/commitments/ask",
        json={"question": "What was promised?"},
    )
    assert answer.status_code == 200
    assert answer.json()["response"] == "The API documentation was promised."


async def test_extraction_completes_only_pending_ids_with_transcript_evidence(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        main,
        "transcribe_audio",
        lambda audio: [TranscribedSegment("The API documentation has been shared.", 0, 1, "en")],
    )
    first = await client.post("/api/sessions", json={"title": "Promise meeting"})
    first_id = first.json()["id"]
    await client.post(
        f"/api/sessions/{first_id}/transcribe",
        content=b"audio",
        headers={"Content-Type": "audio/webm"},
    )

    async def create_commitment(**kwargs) -> CommitmentExtractionResult:
        return CommitmentExtractionResult(
            commitments=[
                ExtractedCommitment(
                    None,
                    "Share the API documentation",
                    "Friday",
                    None,
                    "I will share the API documentation",
                )
            ],
            completed=[],
        )

    monkeypatch.setattr(main, "extract_commitments", create_commitment)
    await client.post(f"/api/commitments/scan/{first_id}")
    original = (await client.get("/api/commitments")).json()[0]

    second = await client.post("/api/sessions", json={"title": "Follow-up meeting"})
    second_id = second.json()["id"]
    await client.post(
        f"/api/sessions/{second_id}/transcribe",
        content=b"audio",
        headers={"Content-Type": "audio/webm"},
    )

    async def complete_commitment(**kwargs) -> CommitmentExtractionResult:
        assert any(
            item["id"] == original["id"] for item in kwargs["pending_commitments"]
        )
        return CommitmentExtractionResult(
            commitments=[],
            completed=[
                CompletedCommitment(original["id"], "The API documentation has been shared."),
                CompletedCommitment("not-a-real-commitment", "This was completed."),
            ],
        )

    monkeypatch.setattr(main, "extract_commitments", complete_commitment)
    response = await client.post(f"/api/commitments/scan/{second_id}")
    rows = await client.get("/api/commitments")
    completed = next(row for row in rows.json() if row["id"] == original["id"])
    assert response.status_code == 200
    assert response.json()["completed"] == 1
    assert completed["status"] == "completed"
    assert completed["completed_in_session_id"] == second_id


async def test_failed_commitment_scan_keeps_transcript_retryable(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        main,
        "transcribe_audio",
        lambda audio: [TranscribedSegment("I will send the notes.", 0, 1, "en")],
    )
    created = await client.post("/api/sessions", json={"title": "Retry test"})
    session_id = created.json()["id"]
    transcribed = await client.post(
        f"/api/sessions/{session_id}/transcribe",
        content=b"audio",
        headers={"Content-Type": "audio/webm"},
    )

    async def fail_extract(**kwargs) -> CommitmentExtractionResult:
        raise LocalAIError("runtime_unavailable", "Ollama is unavailable.")

    monkeypatch.setattr(main, "extract_commitments", fail_extract)
    failed = await client.post(f"/api/commitments/scan/{session_id}")
    transcript = await client.get(f"/api/sessions/{session_id}/transcript")
    backlog = await client.get("/api/commitments/unscanned")
    assert transcribed.status_code == 200
    assert failed.status_code == 503
    assert transcript.json()[0]["text"] == "I will send the notes."
    assert [row["id"] for row in backlog.json()] == [session_id]

    async def retry_extract(**kwargs) -> CommitmentExtractionResult:
        return CommitmentExtractionResult(commitments=[], completed=[])

    monkeypatch.setattr(main, "extract_commitments", retry_extract)
    retry = await client.post(f"/api/commitments/scan/{session_id}")
    assert retry.status_code == 200
    assert (await client.get("/api/commitments/unscanned")).json() == []


async def test_contradiction_detector_flags_cross_meeting_change_as_possible(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    transcripts = iter(
        [
            "We will deliver this by 15 November.",
            "This delivery is planned for 20 November.",
        ]
    )
    monkeypatch.setattr(
        main,
        "transcribe_audio",
        lambda audio: [TranscribedSegment(next(transcripts), 0, 1, "en")],
    )
    earlier = await client.post("/api/sessions", json={"title": "Monday planning"})
    first_id = earlier.json()["id"]
    await client.post(
        f"/api/sessions/{first_id}/transcribe",
        content=b"first",
        headers={"Content-Type": "audio/webm"},
    )
    latest = await client.post("/api/sessions", json={"title": "Wednesday update"})
    latest_id = latest.json()["id"]
    await client.post(
        f"/api/sessions/{latest_id}/transcribe",
        content=b"second",
        headers={"Content-Type": "audio/webm"},
    )

    async def fake_extract(
        *,
        transcript: str,
        meeting_title: str,
        meeting_date: str,
        previous_statements: list[dict[str, str | bool]],
    ) -> ContradictionExtractionResult:
        if meeting_title == "Monday planning":
            assert not previous_statements
            return ContradictionExtractionResult(
                statements=[
                    ExtractedStatement(
                        "Delivery date",
                        "We will deliver this by 15 November.",
                        True,
                    )
                ],
                contradictions=[],
            )
        earlier_statement = next(
            item for item in previous_statements if item["meeting_title"] == "Monday planning"
        )
        return ContradictionExtractionResult(
            statements=[
                ExtractedStatement(
                    "Delivery date",
                    "This delivery is planned for 20 November.",
                    False,
                )
            ],
            contradictions=[
                ExtractedContradiction(
                    str(earlier_statement["id"]),
                    "This delivery is planned for 20 November.",
                    "The delivery date differs from the earlier 15 November commitment.",
                )
            ],
        )

    monkeypatch.setattr(main, "extract_contradictions", fake_extract)
    first_scan = await client.post(f"/api/contradictions/scan/{first_id}")
    second_scan = await client.post(f"/api/contradictions/scan/{latest_id}")
    findings = await client.get("/api/contradictions")
    backlog = await client.get("/api/contradictions/unscanned")

    assert first_scan.status_code == 200
    assert first_scan.json()["contradictions_found"] == 0
    assert second_scan.status_code == 200
    assert second_scan.json()["contradictions_found"] == 1
    assert len(findings.json()) == 1
    finding = findings.json()[0]
    assert finding["previous_statement"]["source_quote"] == "We will deliver this by 15 November."
    assert (
        finding["latest_statement"]["source_quote"]
        == "This delivery is planned for 20 November."
    )
    assert finding["previous_statement"]["meeting_title"] == "Monday planning"
    assert finding["latest_statement"]["meeting_title"] == "Wednesday update"
    assert finding["changes_commitment"] is True
    assert backlog.json() == []


async def test_failed_contradiction_analysis_leaves_meeting_retryable(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        main,
        "transcribe_audio",
        lambda audio: [TranscribedSegment("The review is on Friday.", 0, 1, "en")],
    )
    created = await client.post("/api/sessions", json={"title": "Retry analysis"})
    session_id = created.json()["id"]
    await client.post(
        f"/api/sessions/{session_id}/transcribe",
        content=b"audio",
        headers={"Content-Type": "audio/webm"},
    )

    async def fail_extract(**kwargs) -> ContradictionExtractionResult:
        raise LocalAIError("runtime_unavailable", "Ollama is unavailable.")

    monkeypatch.setattr(main, "extract_contradictions", fail_extract)
    failed = await client.post(f"/api/contradictions/scan/{session_id}")
    backlog = await client.get("/api/contradictions/unscanned")
    assert failed.status_code == 503
    assert [row["id"] for row in backlog.json()] == [session_id]
