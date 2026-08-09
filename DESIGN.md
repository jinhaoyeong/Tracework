---
name: Tracework
description: A source-grounded personal knowledge brain with an inspectable retrieval workbench.
colors:
  ink: "#17211f"
  paper: "#f2f5f2"
  paper-deep: "#e0e7e4"
  rail: "#d7dfdc"
  vermilion: "#c84935"
  vermilion-dark: "#91382b"
  teal: "#1d6f73"
  blue: "#365a77"
  line: "#c7cfcc"
  line-strong: "#a9b5b1"
typography:
  display:
    fontFamily: "Trebuchet MS, Segoe UI, sans-serif"
    fontSize: "clamp(40px, 5.6vw, 72px)"
    fontWeight: 720
    lineHeight: 0.93
    letterSpacing: "-0.075em"
  headline:
    fontFamily: "Trebuchet MS, Segoe UI, sans-serif"
    fontSize: "30px"
    fontWeight: 720
    lineHeight: 1
    letterSpacing: "-0.06em"
  title:
    fontFamily: "Trebuchet MS, Segoe UI, sans-serif"
    fontSize: "18px"
    fontWeight: 750
    lineHeight: 1.08
    letterSpacing: "-0.045em"
  body:
    fontFamily: "Trebuchet MS, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Trebuchet MS, Segoe UI, sans-serif"
    fontSize: "9px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.12em"
rounded:
  none: "0px"
  control: "0px"
spacing:
  xs: "5px"
  sm: "9px"
  md: "15px"
  lg: "21px"
  xl: "30px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "40px"
  button-signal:
    backgroundColor: "{colors.vermilion}"
    textColor: "#fff8f4"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "41px"
  input-search:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 8px 7px 17px"
    height: "57px"
---

# Design System: Tracework

## Overview

**Creative North Star: "The Trace Table"**

Tracework is a cool drafting surface for personal memory: orderly enough to trust, visibly marked enough to question. The UI is built from ruled lanes, registration marks, and tonal paper layers. It refuses a generic chat room as the primary composition; the answer, ranked evidence, and inspected source belong to one working view.

The system is light because the product is used at a desk beside real code and notes. Ink-black text carries the working material, teal labels name the system, and vermilion appears as a deliberate signal for active retrieval and provenance. Motion is restrained: state changes may lift or shift a line, but the evidence itself stays readable.

**Key Characteristics:**
- Cool mineral paper and a drafting-table rail
- Hairline rules and registration marks instead of decorative cards
- One vermilion signal for active retrieval and source focus
- Evidence rows and source inspection as the signature interaction

## Colors

The palette uses cool neutrals as the field, a dark ink for structure, teal for system annotation, and vermilion for the moment that needs attention.

### Primary
- **Vermilion Signal** (#c84935): Active retrieval, selected evidence, and the answer's source signal.
- **Deep Vermilion** (#91382b): High-contrast label text and source actions where the primary signal needs more weight.

### Secondary
- **Registry Teal** (#1d6f73): Pipeline labels, vector/provenance annotation, and quiet interactive affordances.
- **Instrument Blue** (#365a77): Reserved for future comparative evidence states; keep it subordinate to teal and vermilion.

### Neutral
- **Ink** (#17211f): Main text, structural borders, and the primary action.
- **Cool Paper** (#f2f5f2): Main workbench surface and readable content field.
- **Deep Paper** (#e0e7e4): Answer sheet and tonal separation from the workbench.
- **Rail** (#d7dfdc): Capture and pipeline workspace.
- **Line** (#c7cfcc): Dividers and evidence rows.
- **Strong Line** (#a9b5b1): Panel boundaries and input strokes.

### Named Rules

**The One Signal Rule.** Vermilion marks what is active or needs attention. Do not scatter it across decorative accents.

## Typography

**Display Font:** Trebuchet MS (with Segoe UI, sans-serif)
**Body Font:** Trebuchet MS (with Segoe UI, sans-serif)
**Label/Mono Font:** Labels use the same face with small uppercase tracking; code remains readable as text, not as a decorative mono costume.

**Character:** The local system stack gives the workbench a friendly, slightly engineered voice without requiring a network font. Heavy, tight display type creates the first gesture; small tracked labels make the evidence apparatus legible.

### Hierarchy
- **Display** (720, `clamp(40px, 5.6vw, 72px)`, `0.93`): The opening question and primary product statement.
- **Headline** (720, `30px`, `1`): Workbench section titles such as the evidence stream.
- **Title** (750, `18px`, `1.08`): Source and inspector titles.
- **Body** (400, `13px`, `1.6`): Explanations and grounded answer text; keep measures readable.
- **Label** (800, `9px`, `0.12em`, uppercase): Pipeline, provenance, and retrieval state labels.

### Named Rules

**The Question Leads Rule.** The visitor's question is the largest readable object in the first workbench view; supporting labels stay subordinate.

## Layout

Desktop uses three working lanes: a 252px capture rail, a flexible central workbench, and a 319px source inspector. The main lane has a maximum content measure near 900px and a quiet horizontal rule rhythm. The first view puts the query above the grounded answer, then the ranked evidence stream; the inspector remains available without a modal.

At medium widths the inspector moves below the two-column workspace. At widths below 840px the workbench precedes capture so the retrieval task is immediately available; the capture rail follows as a full-width input surface. At 580px and below, the query form wraps its action to a full-width row and evidence snippets may use multiple lines.

## Elevation & Depth

Tracework is flat by default. Depth comes from tonal paper changes and one-pixel structural rules. The query field receives a restrained vermilion offset shadow and the notification uses a soft ink offset to separate it from the page; list rows do not become floating cards.

### Shadow Vocabulary
- **Query registration** (`9px 9px 0 rgba(200, 73, 53, 0.09)`): A quiet offset that makes the question feel registered to the workbench.
- **Notice lift** (`8px 8px 0 rgba(23, 33, 31, 0.1)`): A temporary state-only lift for local feedback.

### Named Rules

**The Flat Evidence Rule.** Evidence stays on the page and in the reading flow; never hide provenance in a floating or modal surface.

## Shapes

Forms are predominantly square and precise. Borders are hairlines or one-pixel structural rules; corners do not soften the evidence system. The only circular form is a small status dot, used as a live signal rather than a decorative badge. Text labels use short ruled underlines instead of pill containers.

## Components

### Buttons
- **Shape:** Square, one-pixel border, no radius (`0px`).
- **Primary:** Ink background with cool-paper text, 40px high, uppercase tracked label, and a right-facing arrow.
- **Signal:** Vermilion background with warm-white text; used for retrieve, not for every action.
- **Hover / Focus:** Hover shifts the primary toward vermilion; focus uses a visible 2px vermilion outline with a 3px offset.
- **Secondary / Ghost:** Cool transparent surfaces or text-only rules; never imitate the primary action.

### Cards / Containers
- **Corner Style:** Square, no radius.
- **Background:** Tonal paper changes divide the capture rail, answer sheet, and inspector.
- **Shadow Strategy:** Structural rules first; only the query and transient notice use offset depth.
- **Border:** One-pixel ink or cool-gray rules.
- **Internal Padding:** Compact 15–21px units for evidence; 25–30px for the main opening surface.

### Inputs / Fields
- **Style:** Transparent or cool-paper fields with ruled bottom borders; the content textarea uses a one-pixel frame.
- **Focus:** Vermilion border and visible focus outline; no glow.
- **Error / Disabled:** Errors use vermilion feedback; disabled controls reduce opacity and retain readable labels.

### Navigation
- **Style:** The top bar is a quiet identity strip with the local index status and a plain clear action. It does not compete with the question.
- **Mobile:** The identity and local status wrap into two rows; the workbench follows immediately.

### Evidence Stream

The ranked evidence stream is a full-width list rather than a card grid. Each row exposes rank, source kind, source path, chunk title, snippet, matched terms, and score. Selecting a row updates the inspector and the answer citations without leaving the current view.

### Retrieval Lab Controls

The answer sheet is also the method switch: hashed baseline, local neural, pgvector, and a same-query comparison action sit in the dark instrument strip. Comparison uses two ruled columns, with teal for local neural and instrument blue for pgvector. The explanatory status row makes provider readiness, indexing progress, database sync, and failure visible without turning the screen into a settings page.

### Vector Search Debug

When pgvector returns results, a ruled debug panel exposes the query, embedding dimensions, database, candidate count, top-K, source-kind filter, distance metric, and first-result distance. It is a teaching instrument, not a decorative dashboard: the panel should make the database operation legible and lead the user back to the source inspector.

### Source Inspector

The inspector is the product's signature component: selected source, exact passage, vector/term score split, offsets, embedding version, and the transparent extractive-answer boundary share one vertical lane.

## Do's and Don'ts

### Do:
- **Do** keep the question, answer, evidence, and source inspector in one visible workflow.
- **Do** use vermilion sparingly for active retrieval and provenance.
- **Do** preserve source title, path, chunk offset, and embedding version whenever a result is rendered.
- **Do** make the retrieval method and embedding model visible beside the evidence it produced.
- **Do** show vector database distance and metadata filters where a learner can inspect them.
- **Do** keep the local fallback honest about what it can and cannot understand.
- **Do** reflow the workbench so mobile users reach retrieval before ingestion details.

### Don't:
- **Don't** replace the evidence stream with a generic chat transcript.
- **Don't** use colored borders, gradients, or floating card stacks as decoration.
- **Don't** present weak near-matches as grounded citations.
- **Don't** hide provider or embedding limitations behind confident copy.
- **Don't** make a neural score look like proof; comparison should lead back to source inspection.
- **Don't** expose a Supabase service-role credential to the browser or disguise a missing database as a local result.
