# Database schema

SQLite database: `storage/assistant.db` by default. Do not commit it or user content.

- `sessions`: identifier, title, mode, lifecycle status, created and ended timestamps.
- `transcript_segments`: session link, original text, source, speaker, timestamps, language, finality.
- `session_notes`: summary and JSON decision/action-item fields.

SQLAlchemy metadata initializes these tables on API startup. Formal Alembic migrations and SQLite FTS5 indexing are not configured yet; both are needed before a production data upgrade path.
