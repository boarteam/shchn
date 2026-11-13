// Where to cut pending text for the next extraction call.

const SENTENCE_END = /[.!?…](?=["'»”)\]]*(?:\s|$))|\n/g;

/** Index just past the last sentence end (or line break), or 0 if there is none. */
export function lastSentenceEnd(text: string): number {
  let end = 0;
  for (const match of text.matchAll(SENTENCE_END)) end = match.index + match[0].length;
  return end;
}

/**
 * Returns how many characters of `text` to send now, or 0 to wait for more.
 * Text over `max` is cut at the best boundary before `max`. With `force` (the
 * speaker paused, input ended, or the input is a document) everything goes;
 * otherwise only complete sentences do.
 */
export function chooseCut(text: string, max: number, force: boolean): number {
  if (text.length > max) return bestBoundary(text, max);
  return force ? text.length : lastSentenceEnd(text);
}

/** Index just past the last whole word: speech-to-text chunks can end mid-word. */
export function lastWordBoundary(text: string): number {
  if (/\s$/.test(text)) return text.length;
  const match = /\s\S*$/.exec(text);
  return match ? match.index + 1 : 0;
}

function bestBoundary(text: string, max: number): number {
  const head = text.slice(0, max);
  const paragraph = head.lastIndexOf("\n\n");
  if (paragraph > max * 0.5) return paragraph + 2;
  const sentence = lastSentenceEnd(head);
  if (sentence > max * 0.3) return sentence;
  const space = head.lastIndexOf(" ");
  return space > 0 ? space + 1 : max;
}
