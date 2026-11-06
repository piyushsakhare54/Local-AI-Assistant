import type { Session, TranscriptSegment } from './api';

export type SummaryStyle = 'to-the-point' | 'simple-explanation';

export function summaryQuestion(style: SummaryStyle): string {
  const styleInstructions = style === 'to-the-point'
    ? 'Summarize what the speaker says or asks in a few concise bullet points. A question is meaningful transcript content; do not call it incomplete just because it has no answer. Include decisions and explicitly agreed action items only when present.'
    : 'Explain what the transcript says in the simplest possible words, using short sentences. If the speaker asks a question, explain what they want to know; do not answer that question unless the transcript provides the answer.';

  return [
    'Summarize the transcript below using only its facts.',
    styleInstructions,
    'The transcript may be short; summarize the text that is present and do not claim it is missing or has no content when words are present.',
    'Do not invent information or turn a scheduled event into an action item.',
    'Do not include reasoning. Return only the summary.',
  ].join(' ');
}

export function summaryPdfFileName(title: string): string {
  const safeTitle = title
    .normalize('NFKD')
    .replace(/[^\w -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${safeTitle || 'conversation'}-summary.pdf`;
}

export function createSummaryPdfHtml(
  session: Session,
  segments: TranscriptSegment[],
  summary: string,
): string {
  const transcript = segments
    .map(
      (segment) =>
        `<li><time>${formatTimestamp(segment.start_time)}</time><span>${escapeHtml(segment.text)}</span></li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(session.title)} — Summary</title>
<style>
@page { size: A4; margin: 20mm 18mm 22mm; }
* { box-sizing: border-box; }
body { color: #202820; font: 11pt/1.55 Arial, sans-serif; }
h1 { color: #253b29; font-size: 24pt; line-height: 1.2; margin: 0 0 6mm; }
h2 { border-bottom: 1px solid #d5dfd1; color: #405d3d; font-size: 14pt; margin: 11mm 0 4mm; padding-bottom: 2mm; }
.meta { color: #667366; font-size: 9pt; margin: 0 0 10mm; }
.summary { white-space: pre-wrap; overflow-wrap: anywhere; }
ol { list-style: none; margin: 0; padding: 0; }
li { break-inside: avoid; display: grid; gap: 4mm; grid-template-columns: 15mm 1fr; margin: 0 0 4mm; }
time { color: #64745f; font-size: 9pt; }
.transcript { border-top: 1px solid #d5dfd1; margin-top: 7mm; padding-top: 3mm; }
</style>
</head>
<body>
<h1>${escapeHtml(session.title)}</h1>
<p class="meta">Session summary · ${escapeHtml(formatDate(session.created_at))}</p>
<h2>Summary</h2>
<div class="summary">${escapeHtml(summary.trim())}</div>
<section class="transcript">
<h2>Full transcript</h2>
<ol>${transcript}</ol>
</section>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}
