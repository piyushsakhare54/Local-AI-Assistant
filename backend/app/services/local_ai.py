from __future__ import annotations

import httpx

from app.config import settings

OLLAMA_URL = "http://127.0.0.1:11434"


class LocalAIError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


async def ai_status() -> str:
    try:
        async with httpx.AsyncClient(base_url=OLLAMA_URL, timeout=2.0) as client:
            response = await client.get("/api/tags")
            response.raise_for_status()
    except (httpx.HTTPError, OSError):
        return "runtime_unavailable"

    models = response.json().get("models", [])
    if any(model.get("name") == settings.ollama_model for model in models):
        return "ready"
    return "model_not_installed"


async def answer_question(transcript: str, question: str) -> str:
    if not transcript.strip():
        raise LocalAIError("transcript_empty", "Record and transcribe speech before asking AI.")

    return await generate_local_response(
        "Answer the user's question using only the meeting transcript below. "
        "If the answer is not present, say so. Be concise.\n\n"
        f"Transcript:\n{transcript}\n\nQuestion: {question}"
    )


async def answer_commitment_question(context: str, question: str) -> str:
    if not context.strip():
        return "There are no tracked commitments yet."
    return await generate_local_response(
        "Answer the user's question using only these locally tracked commitments. "
        "Distinguish pending from completed items, include the person and due date when known, "
        "and mention the meeting where each item was recorded. Do not invent missing details. "
        "Be concise.\n\n"
        f"Commitment tracker:\n{context}\n\nQuestion: {question}"
    )


async def generate_local_response(
    prompt: str,
    *,
    json_format: bool = False,
    json_schema: dict[str, object] | None = None,
) -> str:
    try:
        async with httpx.AsyncClient(base_url=OLLAMA_URL, timeout=180.0) as client:
            request_body: dict[str, object] = {
                "model": settings.ollama_model,
                "prompt": prompt,
                "stream": False,
                "think": False,
            }
            if json_schema is not None:
                request_body["format"] = json_schema
            elif json_format:
                request_body["format"] = "json"
            response = await client.post(
                "/api/generate",
                json=request_body,
            )
            response.raise_for_status()
    except httpx.ConnectError as error:
        raise LocalAIError(
            "runtime_unavailable",
            "Ollama is not running. Install and start Ollama to enable local AI.",
        ) from error
    except httpx.TimeoutException as error:
        raise LocalAIError("ai_timeout", "The local AI model did not respond in time.") from error
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            raise LocalAIError(
                "model_not_installed",
                f"Install the local AI model with `ollama pull {settings.ollama_model}`.",
            ) from error
        raise LocalAIError(
            "ai_request_failed",
            f"The local AI runtime returned HTTP {error.response.status_code}.",
        ) from error
    except httpx.HTTPError as error:
        raise LocalAIError("ai_request_failed", "Could not reach the local AI runtime.") from error

    try:
        payload = response.json()
    except ValueError as error:
        raise LocalAIError(
            "ai_response_invalid", "The local AI runtime returned invalid JSON."
        ) from error
    if not isinstance(payload, dict) or not isinstance(payload.get("response"), str):
        raise LocalAIError(
            "ai_response_invalid", "The local AI runtime returned an invalid response."
        )

    answer = _final_answer(payload["response"])
    if not answer:
        raise LocalAIError("empty_ai_response", "The local AI model returned an empty response.")
    return answer


def _final_answer(response: str) -> str:
    if "</think>" in response:
        return response.rsplit("</think>", maxsplit=1)[-1].strip()
    return response.split("<think>", maxsplit=1)[0].strip()
