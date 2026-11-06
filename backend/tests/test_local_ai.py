import pytest
from app.services import local_ai
from app.services.local_ai import LocalAIError, _final_answer


def test_final_answer_omits_model_thinking_section() -> None:
    response = "Reasoning that should not be shown</think>\nThursday at 2 PM."

    assert _final_answer(response) == "Thursday at 2 PM."


def test_final_answer_keeps_plain_responses() -> None:
    assert _final_answer("The meeting is on Thursday.") == "The meeting is on Thursday."


async def test_explain_technical_text_requests_a_concise_plain_language_explanation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    excerpt = "We need an asynchronous event-driven ingestion pipeline with idempotent processing."
    expected = (
        "Simple explanation: We need a system that processes incoming data in the background "
        "and prevents the same item from being processed more than once."
    )
    prompts: list[str] = []

    async def fake_generate(prompt: str) -> str:
        prompts.append(prompt)
        return expected

    monkeypatch.setattr(local_ai, "generate_local_response", fake_generate)

    response = await local_ai.explain_technical_text(excerpt)

    assert response == expected
    assert len(prompts) == 1
    assert excerpt in prompts[0]
    assert "simple, everyday language" in prompts[0]
    assert "Keep the answer to 1-3 sentences." in prompts[0]


async def test_explain_technical_text_rejects_empty_text() -> None:
    with pytest.raises(LocalAIError, match="Select a sentence"):
        await local_ai.explain_technical_text("  ")


async def test_live_auto_answer_suppresses_responses_without_a_clear_question(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(prompt: str) -> str:
        assert "only if a speaker has asked a clear, answerable question" in prompt
        assert "What is blocking the deployment?" in prompt
        return "NO_QUESTION"

    monkeypatch.setattr(local_ai, "generate_local_response", fake_generate)

    answered, response = await local_ai.answer_live_question(
        "The team needs to review the deployment plan.",
        question="What is blocking the deployment?",
        auto_answer=True,
    )

    assert answered is False
    assert response == ""


async def test_live_manual_answer_uses_the_user_question_and_recent_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(prompt: str) -> str:
        assert "Live transcript so far:\nThe release is blocked by a missing secret." in prompt
        assert "User's question: What should we do?" in prompt
        return "Ask the platform team to configure the missing secret."

    monkeypatch.setattr(local_ai, "generate_local_response", fake_generate)

    answered, response = await local_ai.answer_live_question(
        "The release is blocked by a missing secret.",
        question="What should we do?",
    )

    assert answered is True
    assert response == "Ask the platform team to configure the missing secret."


async def test_screen_analysis_uses_configured_local_vision_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, list[str]]] = []

    async def fake_generate(
        prompt: str,
        *,
        model: str | None = None,
        images: list[str] | None = None,
    ) -> str:
        calls.append((prompt, model or "", images or []))
        return "The screen shows a deployment checklist."

    monkeypatch.setattr(local_ai, "generate_local_response", fake_generate)

    response = await local_ai.analyze_screen_image(
        "c2NyZWVuc2hvdA==",
        question="What is on screen?",
        transcript="We are preparing the release.",
    )

    assert response == "The screen shows a deployment checklist."
    assert calls[0][1] == local_ai.settings.ollama_vision_model
    assert calls[0][2] == ["c2NyZWVuc2hvdA=="]
    assert "We are preparing the release." in calls[0][0]


async def test_screen_analysis_rejects_invalid_image_data() -> None:
    with pytest.raises(LocalAIError) as error:
        await local_ai.analyze_screen_image(
            "not-base64!",
            question="Describe this",
            transcript="",
        )

    assert error.value.code == "invalid_image"
