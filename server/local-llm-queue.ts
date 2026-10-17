export class LocalLlmQueueError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

type Waiter = {
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  cleanup: () => void
  onPosition: (position: number) => void
}

// A single model slot with a bounded FIFO queue. Waiting never invokes Ollama.
export class LocalLlmQueue {
  private active = false
  private readonly waiting: Waiter[] = []

  constructor(private readonly maxSize: number, private readonly timeoutMs: number) {}

  snapshot() { return { active: Number(this.active), waiting: this.waiting.length, maxSize: this.maxSize } }

  acquire(signal: AbortSignal, onPosition: (position: number) => void): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('Запрос отменён.'))
    if (!this.active) {
      this.active = true
      return Promise.resolve(this.releaseOnce())
    }
    if (this.waiting.length >= this.maxSize) {
      return Promise.reject(new LocalLlmQueueError(this.maxSize === 0 ? 409 : 503, this.maxSize === 0
        ? 'Локальная модель занята. Дождитесь завершения запроса.'
        : 'Очередь заполнена. Повторите запрос позже.'))
    }
    return new Promise((resolve, reject) => {
      const remove = (error: Error) => {
        const index = this.waiting.indexOf(waiter)
        if (index < 0) return
        this.waiting.splice(index, 1)
        waiter.cleanup()
        reject(error)
        this.updatePositions()
      }
      const cancel = () => remove(new Error('Запрос отменён.'))
      const timer = setTimeout(() => remove(new LocalLlmQueueError(504, 'Превышено время ожидания в очереди. Повторите запрос позже.')), this.timeoutMs)
      const waiter: Waiter = { signal, resolve, reject, onPosition, cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', cancel) } }
      this.waiting.push(waiter)
      signal.addEventListener('abort', cancel, { once: true })
      onPosition(this.waiting.length)
    })
  }

  private releaseOnce() {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = false
      let next: Waiter | undefined
      while ((next = this.waiting.shift())) {
        next.cleanup()
        if (next.signal.aborted) { next.reject(new Error('Запрос отменён.')); continue }
        this.active = true
        next.resolve(this.releaseOnce())
        break
      }
      this.updatePositions()
    }
  }

  private updatePositions() {
    for (const waiter of [...this.waiting]) {
      const index = this.waiting.indexOf(waiter)
      if (index >= 0) waiter.onPosition(index + 1)
    }
  }
}
