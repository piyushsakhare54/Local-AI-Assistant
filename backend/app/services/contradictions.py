from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from app.services.commitments import is_transcript_quote, optional_text
from app.services.local_ai import LocalAIError, generate_local_response


@dataclass(frozen=True)
class ExtractedStatement:
    topic: str
    source_quote: str
    is_commitment: bool


@dataclass(frozen=True)
class ExtractedContradiction:
    previous_statement_id: str
    latest_source_quote: str
    explanation: str


@dataclass(frozen=True)
class ContradictionExtractionResult:
    statements: list[ExtractedStatement]
    contradictions: list[ExtractedContradiction]


CONTRADICTION_RESPONSE_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "statements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string"},
                    "source_quote": {"type": "string"},
                    "is_commitment": {"type": "boolean"},
                },
                "required": ["topic", "source_quote", "is_commitment"],
                "additionalProperties": False,
            },
        },
        "contradictions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "previous_statement_id": {"type": "string"},
                    "latest_source_quote": {"type": "string"},
                    "explanation": {"type": "string"},
                },
                "required": [
                    "previous_statement_id",
                    "latest_source_quote",
                    "explanation",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": ["statements", "contradictions"],
    "additionalProperties": False,
}


async def extract_contradictions(
    *,
    transcript: str,
    meeting_title: str,
    meeting_date: str,
    previous_statements: list[dict[str, str | bool]],
) -> ContradictionExtractionResult:
    prompt = (
        "Analyze this meeting transcript for concrete statements about plans, dates, decisions, "
        "deliverables, quantities, ownership, or other facts that may later change. Extract only "
        "clear statements that could be compared across meetings. Do not invent the speaker's "
        "identity. Use the exact source quote as the statement; do not paraphrase, normalize, or "
        "correct dates or numbers. Set is_commitment true only for an explicit promise or "
        "commitment.\n"
        "Compare each current statement with the earlier statements supplied below. Flag only a "
        "plausible material inconsistency about the same topic; different details, added context, "
        "or compatible updates are not contradictions. A revised plan or deadline may be a "
        "possible contradiction even if it is an intentional change. Do not decide who is right "
        "or assume the later statement is an error. Explain the difference neutrally. Each "
        "candidate must cite an earlier statement ID and the exact latest quote from this "
        "transcript. If uncertain, do not flag it.\n"
        "Return JSON only with this shape: "
        '{"statements":[{"topic":"...","source_quote":"...","is_commitment":false}],'
        '"contradictions":[{"previous_statement_id":"...","latest_source_quote":"...",'
        '"explanation":"..."}]}.\n'
        f"Meeting title: {meeting_title}\nMeeting date: {meeting_date}\n"
        "Earlier statements JSON:\n"
        f"{json.dumps(previous_statements, ensure_ascii=False)}\n"
        f"Current transcript:\n{transcript}"
    )
    raw = await generate_local_response(
        prompt,
        json_schema=CONTRADICTION_RESPONSE_SCHEMA,
    )
    try:
        payload: Any = json.loads(raw)
    except json.JSONDecodeError as error:
        raise _invalid_response() from error

    if (
        not isinstance(payload, dict)
        or "statements" not in payload
        or "contradictions" not in payload
    ):
        raise _invalid_response()
    statements = payload["statements"]
    contradictions = payload["contradictions"]
    if not isinstance(statements, list) or not isinstance(contradictions, list):
        raise _invalid_response()

    extracted_statements: list[ExtractedStatement] = []
    unsupported_statement_count = 0
    for item in statements[:100]:
        if not isinstance(item, dict):
            raise _invalid_response()
        topic = optional_text(item.get("topic"), limit=200)
        quote = optional_text(item.get("source_quote"), limit=1000)
        if not topic or not quote or not is_transcript_quote(quote, transcript):
            unsupported_statement_count += 1
            continue
        is_commitment = item.get("is_commitment")
        extracted_statements.append(
            ExtractedStatement(topic, quote, is_commitment is True)
        )

    previous_by_id = {
        str(item["id"]): item
        for item in previous_statements
        if isinstance(item.get("id"), str)
    }
    extracted_contradictions: list[ExtractedContradiction] = []
    for item in contradictions[:100]:
        if not isinstance(item, dict):
            raise _invalid_response()
        previous_id = optional_text(item.get("previous_statement_id"), limit=36)
        latest_quote = optional_text(item.get("latest_source_quote"), limit=1000)
        explanation = optional_text(item.get("explanation"), limit=1000)
        if (
            not previous_id
            or previous_id not in previous_by_id
            or not latest_quote
            or not is_transcript_quote(latest_quote, transcript)
            or not explanation
        ):
            raise _invalid_response()
        extracted_contradictions.append(
            ExtractedContradiction(previous_id, latest_quote, explanation)
        )
        if latest_quote not in {statement.source_quote for statement in extracted_statements}:
            previous_topic = optional_text(previous_by_id[previous_id].get("topic"), limit=200)
            extracted_statements.append(
                ExtractedStatement(previous_topic or "Possible inconsistency", latest_quote, False)
            )

    current_quotes = {item.source_quote for item in extracted_statements}
    if (
        unsupported_statement_count
        and not current_quotes
        and not extracted_contradictions
    ):
        raise _invalid_response()
    if any(item.latest_source_quote not in current_quotes for item in extracted_contradictions):
        raise _invalid_response()
    return ContradictionExtractionResult(extracted_statements, extracted_contradictions)


def _invalid_response() -> LocalAIError:
    return LocalAIError(
        "contradiction_response_invalid",
        "The local AI returned invalid contradiction analysis. You can retry the meeting scan.",
    )
