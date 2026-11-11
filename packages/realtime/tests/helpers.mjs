export async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`);
}

export async function readSseFrames(response, count, { signal } = {}) {
  const frames = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (frames.length < count) {
      if (signal?.aborted) break;
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0 && frames.length < count) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!frame.split('\n').every((line) => line.startsWith(':'))) frames.push(frame);
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return frames;
}
