from datetime import date

import pytest
from app.services import commitments
from app.services.local_ai import LocalAIError


async def test_extraction_keeps_only_transcript_backed_quotes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(prompt: str, *, json_format: bool = False) -> str:
        assert json_format
        assert "2025-03-07" in prompt
        return (
            '{"commitments":['
            '{"person":null,"task":"Share docs","due_date_text":"Friday",'
            '"due_date":"2025-03-07","source_quote":"I will share the docs Friday."}],'
            '"completed":[{"id":"known-id","evidence":"The docs have been shared."}]}'
        )

    monkeypatch.setattr(commitments, "generate_local_response", fake_generate)
    result = await commitments.extract_commitments(
        transcript="I will share the docs Friday. The docs have been shared.",
        meeting_title="Review",
        meeting_date=date(2025, 3, 7),
        pending_commitments=[],
    )
    assert len(result.commitments) == 1
    assert result.commitments[0].due_date == date(2025, 3, 7)
    assert result.completed[0].commitment_id == "known-id"


async def test_extraction_rejects_quotes_not_found_in_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(prompt: str, *, json_format: bool = False) -> str:
        return (
            '{"commitments":[{"person":null,"task":"Invented action","due_date_text":null,'
            '"due_date":null,"source_quote":"This sentence is not in the transcript."}],'
            '"completed":[]}'
        )

    monkeypatch.setattr(commitments, "generate_local_response", fake_generate)
    with pytest.raises(LocalAIError) as error:
        await commitments.extract_commitments(
            transcript="No commitment here.",
            meeting_title="Review",
            meeting_date=date(2025, 3, 7),
            pending_commitments=[],
        )
    assert error.value.code == "commitment_response_invalid"


async def test_extraction_rejects_malformed_structured_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(prompt: str, *, json_format: bool = False) -> str:
        return "not json"

    monkeypatch.setattr(commitments, "generate_local_response", fake_generate)
    with pytest.raises(LocalAIError) as error:
        await commitments.extract_commitments(
            transcript="I will send the file.",
            meeting_title="Review",
            meeting_date=date(2025, 3, 7),
            pending_commitments=[],
        )
    assert error.value.code == "commitment_response_invalid"
