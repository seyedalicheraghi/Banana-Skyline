// Minimal event emitter. onAny(fn) receives (type, payload) for every event.
export class Emitter {
  #handlers = new Map();
  #any = new Set();

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  onAny(fn) {
    this.#any.add(fn);
    return () => this.#any.delete(fn);
  }

  emit(type, payload = {}) {
    for (const fn of [...(this.#handlers.get(type) ?? [])]) fn(payload);
    for (const fn of [...this.#any]) fn(type, payload);
  }

  removeAllListeners() {
    this.#handlers.clear();
    this.#any.clear();
  }
}
