const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const codes = value => [...new Set(String(value ?? '').match(/\b[A-Z][A-Z0-9-]{1,11}\b/g) ?? [])]
  .filter(value => !['NR','NA','NE','TCM'].includes(value));
export function mergeCandidates(input) {
  const result = [];
  for (const candidate of [...input].sort((a,b) => a.id.localeCompare(b.id))) {
    const code = codes(candidate.instrument);
    const existing = result.find(item => {
      if (norm(item.name) !== norm(candidate.name) || norm(item.domain) !== norm(candidate.domain)) return false;
      const previous = codes(item.instrument);
      // An explicit different instrument remains a separate choice.
      return !code.length || !previous.length || code.some(value => previous.includes(value));
    });
    if (!existing) { result.push(structuredClone(candidate)); continue; }
    existing.aliases = [...new Set([...(existing.aliases ?? []), candidate.name, candidate.instrument].filter(Boolean))];
    existing.reportedTimes = [...new Set([...(existing.reportedTimes ?? []), ...(candidate.reportedTimes ?? [])])];
    existing.primary ||= candidate.primary;
    existing.evidence = [...new Map([...existing.evidence, ...candidate.evidence].map(e => [
      e.documentId + '/' + e.blockId + '/' + e.quote, e,
    ])).values()];
  }
  return result;
}
