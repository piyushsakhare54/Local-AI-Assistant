import json

import pytest
from app.services import topic_detection
from app.services.local_ai import LocalAIError
from app.services.topic_detection import TopicTranscriptSegment


def make_segments(count: int) -> list[TopicTranscriptSegment]:
    return [
        TopicTranscriptSegment(
            id=f"segment-{index}",
            text=f"Discussion detail {index}.",
            start_time=float(index * 2),
            end_time=float(index * 2 + 1),
        )
        for index in range(count)
    ]


async def test_topic_detection_merges_same_subject_across_overlapping_chunks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    segments = make_segments(12)
    calls: list[str] = []

    async def fake_generate(
        prompt: str,
        *,
        json_schema: dict[str, object] | None = None,
    ) -> str:
        assert json_schema is not None
        calls.append(prompt)
        first = int(
            prompt.split("Transcript excerpt:\n[", maxsplit=1)[1].split("]", maxsplit=1)[0]
        )
        indices = [
            int(line[1:].split("]", maxsplit=1)[0])
            for line in prompt.splitlines()
            if line.startswith("[")
        ]
        if first == 0:
            topics = [
                {
                    "title": "Project architecture",
                    "summary": "The team discusses system design.",
                    "start_segment_index": indices[0],
                    "end_segment_index": indices[-1],
                }
            ]
        else:
            topics = [
                {
                    "title": "Project architecture",
                    "summary": "The team discusses system design.",
                    "start_segment_index": indices[0],
                    "end_segment_index": indices[-1],
                }
            ]
        return json.dumps({"topics": topics})

    monkeypatch.setattr(topic_detection, "MAX_CHUNK_SEGMENTS", 8)
    monkeypatch.setattr(topic_detection, "CHUNK_OVERLAP_SEGMENTS", 2)
    monkeypatch.setattr(topic_detection, "generate_local_response", fake_generate)

    topics = await topic_detection.detect_topics(segments)

    assert len(calls) == 2
    assert len(topics) == 1
    assert topics[0].title == "Project architecture"
    assert topics[0].start_segment_index == 0
    assert topics[0].end_segment_index == 11


def test_topic_chunks_keep_moving_when_a_single_segment_exceeds_the_chunk_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(topic_detection, "MAX_CHUNK_CHARACTERS", 10)

    chunks = topic_detection._topic_chunks(make_segments(3))

    assert chunks == [(0, 0), (1, 1), (2, 2)]


async def test_topic_detection_rejects_gaps_in_model_segment_ranges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate(
        prompt: str,
        *,
        json_schema: dict[str, object] | None = None,
    ) -> str:
        assert "Identify the main discussion topics" in prompt
        assert json_schema is not None
        return json.dumps(
            {
                "topics": [
                    {
                        "title": "Architecture",
                        "summary": "System design is discussed.",
                        "start_segment_index": 0,
                        "end_segment_index": 0,
                    }
                ]
            }
        )

    monkeypatch.setattr(topic_detection, "generate_local_response", fake_generate)

    with pytest.raises(LocalAIError) as error:
        await topic_detection.detect_topics(make_segments(2))

    assert error.value.code == "topic_response_invalid"
