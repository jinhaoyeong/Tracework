# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Vite + React + TypeScript for the browser experience, with a small Node API and file-backed local index for the first learning slice. The structure keeps embedding, retrieval, and answer generation behind replaceable providers so a hosted model or real vector database can be added without rewriting the UI.

## Users

Primary user: the builder using a private local workspace to remember and query their own notes, code, documentation, screenshots, and other reference material.

## Product Purpose

Personal AI Knowledge Brain turns a growing folder of personal material into a searchable, source-grounded memory. Success means a user can add material, ask a question in natural language, find the most relevant passages, and understand exactly which sources support the result.

## Positioning

The product makes retrieval inspectable: every answer is paired with ranked evidence and enough source context to challenge the answer. It is a learning laboratory for parsing, chunking, embeddings, vector search, reranking, grounding, and evaluation rather than a black-box chat surface.

## Operating Context

The app is used locally in a desktop browser while the user is working across projects. The first slice should support pasted notes and common text/code files, then grow toward PDFs, screenshots, websites, and repositories. Demonstration content must be labeled as synthetic until the user imports real material.

## Capabilities and Constraints

- Ingest pasted text and supported local text/code files.
- Split material into inspectable chunks with source metadata.
- Index chunks with a local hashed baseline or an optional server-side neural embedding provider, then persist the index locally.
- Compare both retrieval engines against the same question before trusting a result.
- Sync neural chunks and source metadata to PostgreSQL with pgvector, then retrieve top-K matches through a server-only database route.
- Inspect database candidates, top-K, source-kind filters, cosine distance, similarity, embedding model, and dimensions.
- Retrieve and rank evidence for a natural-language query.
- Generate a grounded response from retrieved evidence when a model provider is configured; otherwise provide a transparent extractive fallback.
- Never imply that unsupported or unindexed material was searched.
- Keep provider keys server-side and make the first run useful without external credentials.
- Open decisions: PDF/OCR ingestion, authentication, sync ownership, multi-user policies, and LLM generation.

## Evidence on Hand

No user corpus has been supplied yet. The first screen may use clearly labeled synthetic examples to demonstrate the workflow, but it must make the transition to real material obvious.

## Product Principles

- Evidence before confidence.
- Make each retrieval step inspectable.
- Keep the local learning loop fast and reversible.
- Fail transparently when a provider or source is unavailable.
- Preserve the user's source boundaries and provenance.

## Accessibility & Inclusion

The web app should be keyboard-operable, preserve visible focus, maintain readable contrast, expose loading and error states, and avoid relying on color alone to communicate evidence or status.
