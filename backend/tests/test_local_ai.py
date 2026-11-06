from app.services.local_ai import _final_answer


def test_final_answer_omits_model_thinking_section() -> None:
    response = "Reasoning that should not be shown</think>\nThursday at 2 PM."

    assert _final_answer(response) == "Thursday at 2 PM."


def test_final_answer_keeps_plain_responses() -> None:
    assert _final_answer("The meeting is on Thursday.") == "The meeting is on Thursday."
