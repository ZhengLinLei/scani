import { HttpError } from './store.mjs';

export const MAX_PAGE_CAPTURES = 10;
const key = (text) => text.normalize('NFC');
const comparable = (text) => key(text).toLocaleLowerCase();
const weight = (confidence) => Math.max(1, confidence) ** 2;

// A single character error should not make two scans look like different pages.
function similarity(left, right) {
  left = comparable(left);
  right = comparable(right);
  if (left === right) return 1;
  if (Math.min(left.length, right.length) < 4 || Math.abs(left.length - right.length) > 1) return 0;
  let i = 0, j = 0, errors = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++errors > 1) return 0;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return errors + (i < left.length || j < right.length ? 1 : 0) <= 1 ? 0.75 : 0;
}

// Keep whitespace from OCR so paragraph boundaries survive the word alignment.
export function recognitionTokens(result) {
  const matches = [...result.text.matchAll(/\S+\s*/gu)];
  const words = result.words || [];
  const aligned = words.length === matches.length && words.every((word, i) => word.text === matches[i][0].trim());
  return matches.map(([value], i) => ({
    text: value.trim(),
    space: value.slice(value.trimEnd().length),
    confidence: Math.max(0, Math.min(100, aligned ? words[i].confidence : result.confidence))
  }));
}

// Banded edit alignment bounds memory and work even for long OCR documents.
function align(left, right) {
  const n = left.length, m = right.length;
  const radius = Math.max(64, Math.abs(n - m) + 16);
  if (Math.max(n, m) > 10_000 || radius > 512) {
    throw new HttpError(422, 'These captures differ too much to merge. Capture the same full page again.');
  }
  let previous = new Float64Array(m + 1).fill(Infinity);
  previous[0] = 0;
  for (let j = 1; j <= Math.min(m, radius); j++) previous[j] = j;
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const start = Math.max(0, i - radius), end = Math.min(m, i + radius);
    const directions = new Uint8Array(end - start + 1);
    const current = new Float64Array(m + 1).fill(Infinity);
    if (start === 0) { current[0] = i; directions[0] = 1; }
    for (let j = Math.max(1, start); j <= end; j++) {
      const same = similarity(left[i - 1].text, right[j - 1].text);
      const diagonal = previous[j - 1] + (1 - same);
      const deletion = previous[j] + 1, insertion = current[j - 1] + 1;
      current[j] = Math.min(diagonal, deletion, insertion);
      directions[j - start] = current[j] === diagonal ? 0 : current[j] === deletion ? 1 : 2;
    }
    rows.push({ start, directions });
    previous = current;
  }
  const pairs = [];
  let i = n, j = m, matches = 0;
  while (i || j) {
    const direction = i === 0 ? 2 : j === 0 ? 1 : rows[i - 1].directions[j - rows[i - 1].start];
    if (direction === 0) {
      matches += similarity(left[i - 1].text, right[j - 1].text);
      pairs.push([--i, --j]);
    } else if (direction === 1) pairs.push([--i, -1]);
    else pairs.push([-1, --j]);
  }
  if (!n || !m || matches / Math.max(n, m) < 0.55) {
    throw new HttpError(422, 'This does not look like the same page. Capture the same full page again, or use Rescan to replace it.');
  }
  return pairs.reverse();
}

function winner(column) {
  return column.choices.reduce((best, choice) => choice.weight > best.weight ? choice : best);
}

function columnFor(token, gap = 0) {
  return { choices: [{ ...token, weight: weight(token.confidence) }], gap };
}

export function initialRecognition(result, id) {
  return { ids: [id], totalWeight: weight(result.confidence), columns: recognitionTokens(result).map((token) => columnFor(token)) };
}

export function mergeRecognition(page, result, captureId) {
  if (page.textEdited) {
    throw new HttpError(409, 'This page has saved text corrections. Use Rescan to start over, or keep your corrections. Combine captures before editing text.');
  }
  const prior = page.recognition || initialRecognition({ ...page, text: page.rawText ?? page.text }, page.id);
  if (prior.ids.includes(captureId)) return page;
  if (prior.ids.length >= MAX_PAGE_CAPTURES) throw new HttpError(409, 'Maximum 10 captures per page. Review the text or rescan the page to start over.');
  const columns = structuredClone(prior.columns);
  const tokens = recognitionTokens(result);
  // Align against every column, including omissions, so later captures can vote
  // for words omitted by an earlier reading without duplicating them.
  const pairs = align(columns.map(winner), tokens);
  const incomingWeight = weight(result.confidence);
  const merged = pairs.map(([a, b]) => {
    if (a < 0) return columnFor(tokens[b], prior.totalWeight);
    const column = columns[a];
    if (b < 0) column.gap += incomingWeight;
    else {
      const token = tokens[b];
      const choice = column.choices.find((choice) => key(choice.text) === key(token.text));
      if (choice) {
        choice.weight += weight(token.confidence);
        if (token.confidence > choice.confidence) Object.assign(choice, token);
      } else column.choices.push({ ...token, weight: weight(token.confidence) });
    }
    return column;
  });
  const selected = merged.map((column) => ({ column, choice: winner(column) }))
    .filter(({ column, choice }) => choice.weight >= column.gap).map(({ choice }) => choice);
  const text = selected.map((token, index) => token.text + (token.space || (index < selected.length - 1 ? ' ' : ''))).join('');
  if (!text.trim()) throw new HttpError(422, 'No reliable combined text found. Try a clearer capture.');
  const { rawText, aiStatus, aiError, ...original } = page;
  return {
    ...original, text,
    // This remains an OCR confidence estimate, not a measured accuracy score.
    confidence: Math.round(selected.reduce((sum, token) => sum + token.confidence, 0) / selected.length),
    blank: false,
    captureCount: prior.ids.length + 1,
    recognition: { ids: [...prior.ids, captureId], columns: merged, totalWeight: prior.totalWeight + incomingWeight }
  };
}

export function publicSession(session) {
  return { ...session, pages: session.pages.map(({ recognition, rawText, ...page }) => page) };
}
