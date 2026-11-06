import pytest
from app.services import contradictions
from app.services.local_ai import LocalAIError


async def test_extraction_validates_statements_and_linked_prior_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(
        prompt: str,
        *,
        json_format: bool = False,
        json_schema: dict[str, object] | None = None,
    ) -> str:
        assert json_schema is not None
        assert "2026-11-06" in prompt
        return (
            '{"statements":[{"topic":"Delivery date",'
            '"source_quote":"This delivery is planned for 20 November.","is_commitment":false}],'
            '"contradictions":[{"previous_statement_id":"earlier-id",'
            '"latest_source_quote":"This delivery is planned for 20 November.",'
            '"explanation":"The delivery date differs from the earlier commitment."}]}'
        )

    monkeypatch.setattr(contradictions, "generate_local_response", fake_generate)
    result = await contradictions.extract_contradictions(
        transcript="This delivery is planned for 20 November.",
        meeting_title="Wednesday meeting",
        meeting_date="2026-11-06",
        previous_statements=[
            {
                "id": "earlier-id",
                "topic": "Delivery date",
                "statement": "Deliver by 15 November",
                "source_quote": "We will deliver this by 15 November.",
                "is_commitment": True,
            }
        ],
    )
    assert len(result.statements) == 1
    assert result.statements[0].source_quote == "This delivery is planned for 20 November."
    assert result.contradictions[0].previous_statement_id == "earlier-id"


async def test_extraction_rejects_unlinked_or_unsupported_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(
        prompt: str,
        *,
        json_format: bool = False,
        json_schema: dict[str, object] | None = None,
    ) -> str:
        return (
            '{"statements":[{"topic":"Delivery date",'
            '"source_quote":"Delivery planned for 20 November.", "is_commitment":false}],'
            '"contradictions":[{"previous_statement_id":"unknown-id",'
            '"latest_source_quote":"Delivery planned for 20 November.",'
            '"explanation":"Possible change."}]}'
        )

    monkeypatch.setattr(contradictions, "generate_local_response", fake_generate)
    with pytest.raises(LocalAIError) as error:
        await contradictions.extract_contradictions(
            transcript="Delivery planned for 20 November.",
            meeting_title="Wednesday meeting",
            meeting_date="2026-11-06",
            previous_statements=[],
        )
    assert error.value.code == "contradiction_response_invalid"
