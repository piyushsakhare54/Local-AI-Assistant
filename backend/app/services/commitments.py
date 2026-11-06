from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.services.local_ai import LocalAIError, generate_local_response


@dataclass(frozen=True)
class ExtractedCommitment:
    person: str | None
    task: str
    due_date_text: str | None
    due_date: date | None
    source_quote: str


@dataclass(frozen=True)
class CompletedCommitment:
    commitment_id: str
    evidence: str


@dataclass(frozen=True)
class CommitmentExtractionResult:
    commitments: list[ExtractedCommitment]
    completed: list[CompletedCommitment]


async def extract_commitments(
    *,
    transcript: str,
    meeting_title: str,
    meeting_date: date,
    pending_commitments: list[dict[str, str | None]],
) -> CommitmentExtractionResult:
    pending_context = json.dumps(pending_commitments, ensure_ascii=False)
    prompt = (
        "Extract explicit promises, assignments, and commitments from this meeting transcript. "
        "A commitment must be a clear statement that someone will do a specific task; exclude "
        "suggestions, questions, wishes, and unaccepted proposals. Only include commitments newly "
        "made in this meeting, not old promises merely discussed. If the speaker says I or we but "
        "their identity is not known, use person null rather than guessing. Preserve the spoken "
        "deadline in due_date_text. Fill due_date as YYYY-MM-DD only when it can be confidently "
        "resolved from the meeting date; otherwise use null. Include a short exact source_quote.\n"
        "Compare against the outstanding prior commitments. Mark one completed only if this "
        "transcript clearly says the task was completed; provide its exact id and a short evidence "
        "quote. Do not infer completion from silence, plans, or ambiguous wording.\n"
        "Return JSON only with this exact shape: "
        '{"commitments":[{"person":null,"task":"...","due_date_text":null,'
        '"due_date":null,"source_quote":"..."}],"completed":[{"id":"...","evidence":"..."}]}.\n'
        f"Meeting title: {meeting_title}\n"
        f"Meeting date: {meeting_date.isoformat()}\n"
        f"Outstanding commitments JSON: {pending_context}\n"
        f"Transcript:\n{transcript}"
    )
    raw = await generate_local_response(prompt, json_format=True)
    try:
        payload: Any = json.loads(raw)
    except json.JSONDecodeError as error:
        raise LocalAIError(
            "commitment_response_invalid",
            "The local AI returned invalid structured commitment data. You can retry the scan.",
        ) from error

    if not isinstance(payload, dict):
        raise _invalid_response()
    if "commitments" not in payload or "completed" not in payload:
        raise _invalid_response()
    commitments = payload["commitments"]
    completed = payload["completed"]
    if not isinstance(commitments, list) or not isinstance(completed, list):
        raise _invalid_response()

    extracted: list[ExtractedCommitment] = []
    for item in commitments[:50]:
        if not isinstance(item, dict):
            raise _invalid_response()
        task = optional_text(item.get("task"), limit=1000)
        quote = optional_text(item.get("source_quote"), limit=1000)
        if not task or not quote or not is_transcript_quote(quote, transcript):
            raise _invalid_response()
        due_date_text = optional_text(item.get("due_date_text"), limit=120)
        due_date = _parse_date(item.get("due_date"))
        extracted.append(
            ExtractedCommitment(
                person=optional_text(item.get("person"), limit=120),
                task=task,
                due_date_text=due_date_text,
                due_date=due_date,
                source_quote=quote,
            )
        )

    completed_items: list[CompletedCommitment] = []
    for item in completed[:100]:
        if not isinstance(item, dict):
            raise _invalid_response()
        commitment_id = optional_text(item.get("id"), limit=36)
        evidence = optional_text(item.get("evidence"), limit=1000)
        if not commitment_id or not evidence or not is_transcript_quote(evidence, transcript):
            raise _invalid_response()
        completed_items.append(CompletedCommitment(commitment_id, evidence))

    return CommitmentExtractionResult(extracted, completed_items)


def _parse_date(value: object) -> date | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def optional_text(value: object, *, limit: int) -> str | None:
    if value is None or not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned[:limit] or None


def is_transcript_quote(quote: str, transcript: str) -> bool:
    normalized_quote = " ".join(quote.casefold().split())
    normalized_transcript = " ".join(transcript.casefold().split())
    return normalized_quote in normalized_transcript


def _invalid_response() -> LocalAIError:
    return LocalAIError(
        "commitment_response_invalid",
        "The local AI returned invalid structured commitment data. You can retry the scan.",
    )
