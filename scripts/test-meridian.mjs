import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { searchDocuments } from '../src/lib/rag.ts'

const question = 'Summarise Meridian as it existed in August 2026.'
const document = buildMeridianCorpus()[0]
const dense = searchDocuments([document], question, { engine: 'hashed', limit: 10 })
const lexicalIndex = buildLexicalIndex([document])
const lexical = toLexicalResults(searchLexical(lexicalIndex, question, 10), [document])
const union = buildCandidateUnion({ dense, lexical, limit: 10 })
const ranked = rerank(question, union)
const selected = pruneCandidates(ranked, { maxChunks: 5 }).selected
const selectedText = selected.map((candidate) => candidate.result.chunk.text).join('\n')
const coverageTopics = [
  'Standard',
  'Supported',
  'Institutional',
  'Quiet Month',
  'Journey Guard',
  'Dayline',
  'Continuity Credit',
]

console.log(JSON.stringify({
  source: document.title,
  chunks: document.chunks.length,
  denseCandidates: dense.length,
  lexicalCandidates: lexical.length,
  unionCandidates: union.length,
  rerankedCandidates: ranked.length,
  selectedChunks: selected.length,
  selectedTopics: coverageTopics.filter((topic) => selectedText.toLocaleLowerCase().includes(topic.toLocaleLowerCase())),
  missingTopics: coverageTopics.filter((topic) => !selectedText.toLocaleLowerCase().includes(topic.toLocaleLowerCase())),
  answerKeyExcluded: !document.content.includes('Questions to test Tracework') && !document.content.includes('Expected answer'),
}, null, 2))
