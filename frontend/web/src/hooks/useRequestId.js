import { useRef } from 'react';

/**
 * Prepares a save's request with its `requestId`. Sending the same content again, such as after a
 * timeout, reuses the id and the first attempt's `date`, so the API records the expense or payment
 * only once even if the retry happens after midnight. Changed content is a new save and gets a new
 * id, because the API refuses a reused id with different content. Call `done()` after a save
 * succeeds, so the next one is new even with the same content.
 */
export function useRequestId() {
  const last = useRef(null);

  function prepare(body) {
    const { date, ...content } = body;
    const key = JSON.stringify(content);
    if (last.current?.key !== key) last.current = { key, id: crypto.randomUUID(), date };
    const request = { requestId: last.current.id, ...body };
    if (date !== undefined) request.date = last.current.date;
    return request;
  }

  function done() {
    last.current = null;
  }

  return { prepare, done };
}
