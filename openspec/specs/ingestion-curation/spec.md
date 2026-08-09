# Ingestion Curation Specification

## Purpose

Curates clinical documents BEFORE vectorization: blacklist filtering (dose terms, drug names, posology), chunking at 500–800 characters, embedding generation, metadata tagging (category, source, language, legal framework), pgvector upsert, and re-vectorization. A "zonas prohibidas" sweep plus manual removal in the dashboard keeps prohibited content out of the knowledge base.

## Requirements

### Requirement: REQ-INGEST-1 — Blacklist filter before vectorization

Documents MUST be filtered against a blacklist of dose terms, drug names (e.g. Fluoxetina, Litio, Sertralina), and posology patterns BEFORE any chunking or vectorization; blacklisted content MUST NOT reach the vector store.

#### Scenario: Blacklisted content rejected

- GIVEN a source document containing a dose term
- WHEN the filter runs
- THEN the offending content is excluded from chunking
- AND the exclusion is logged

#### Scenario: Clean content passes

- GIVEN a source document with no blacklisted terms
- WHEN the filter runs
- THEN the document proceeds to chunking
- AND the filter result is recorded

### Requirement: REQ-INGEST-2 — Chunking bounds

Chunks MUST be 500–800 characters; chunk boundaries MUST respect paragraph structure where possible.

#### Scenario: Chunk within bounds

- GIVEN a filtered document
- WHEN chunking runs
- THEN every chunk is between 500 and 800 characters
- AND paragraph boundaries are preferred for splits

#### Scenario: Short passage handling

- GIVEN a passage shorter than 500 characters
- WHEN chunking runs
- THEN the passage MAY be merged with adjacent content
- AND MUST NOT be dropped silently

### Requirement: REQ-INGEST-3 — Embeddings and vector upsert

Each chunk MUST be embedded and upserted into pgvector with an HNSW index; re-upserts MUST not duplicate rows.

#### Scenario: Idempotent upsert

- GIVEN a chunk already present in the vector store
- WHEN the ingestion upsert runs
- THEN the row is updated, not duplicated

### Requirement: REQ-INGEST-4 — Metadata tagging

Every vector row MUST be tagged with category, source, language, and legal framework; metadata MUST be supplied by the pipeline and not inferred at query time.

#### Scenario: Metadata-complete row

- GIVEN an embedded chunk
- WHEN the row is written
- THEN category, source, language, and legal framework are set
- AND the fields match the source document's classification

### Requirement: REQ-INGEST-5 — Re-vectorization

The pipeline MUST support re-vectorization triggers (scheduled or manual from the dashboard) that rebuild affected embeddings without duplicating the corpus.

#### Scenario: Manual re-vectorization

- GIVEN a source document updated
- WHEN the supervisor triggers re-vectorization
- THEN the affected chunks are re-embedded and upserted
- AND stale rows are removed

### Requirement: REQ-INGEST-6 — Prohibited-zones sweep and manual removal

A "zonas prohibidas" sweep MUST scan the corpus for prohibited content after ingestion; supervisors MUST be able to remove chunks manually from the dashboard; removals MUST be audit-logged.

#### Scenario: Sweep detects prohibited chunk

- GIVEN a chunk that passes the initial filter but contains prohibited content
- WHEN the sweep runs
- THEN the chunk is flagged
- AND an alert is raised for manual review

#### Scenario: Manual removal

- GIVEN a flagged chunk
- WHEN a supervisor removes it from the dashboard
- THEN the chunk is deleted from the vector store
- AND the removal is audit-logged

