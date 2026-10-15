/**
 * Shares one in-flight promise per key: two identical concurrent calls get the
 * same promise instead of each spawning a subprocess. The entry is removed when
 * the promise settles (resolved or rejected), so nothing is cached beyond the
 * call itself — TTL caches stay with their owners.
 *
 * @template T
 * @param {Map<string, Promise<T>>} map
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function shared(map, key, fn) {
  const running = map.get(key);
  if (running) return running;
  const job = Promise.resolve().then(fn).finally(() => {
    if (map.get(key) === job) map.delete(key);
  });
  map.set(key, job);
  return job;
}
