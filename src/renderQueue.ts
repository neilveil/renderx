import { logger } from './logger'

export type RenderPriority = 'high' | 'low'

type QueueItem<T> = {
    priority: RenderPriority
    enqueuedAt: number
    execute: () => Promise<T>
    resolve: (value: T) => void
    reject: (reason: unknown) => void
}

let parallelRenders = 10
let maxQueueSize = 30
let activeCount = 0
let queueInitialized = false
const queue: QueueItem<unknown>[] = []

export const initRenderQueue = (maxConcurrency: number): void => {
    if (queueInitialized) return

    parallelRenders = maxConcurrency
    maxQueueSize = maxConcurrency * 3
    queueInitialized = true
}

/**
 * Enqueues a render task. If capacity is available, executes immediately.
 * Otherwise queues by priority (high first, FIFO within same priority).
 * Returns 503 (via rejected promise) if queue is full.
 */
export const enqueue = <T>(priority: RenderPriority, execute: () => Promise<T>): Promise<T> => {
    // Execute immediately if under capacity
    if (activeCount < parallelRenders) {
        activeCount++
        return executeAndDrain(execute)
    }

    // Queue overflow: reject with 503
    if (queue.length >= maxQueueSize) {
        logger.warn(`Render queue full (${queue.length}/${maxQueueSize}), returning 503`)
        return Promise.reject(new Error('Service temporarily unavailable: render queue full'))
    }

    // Warn at 80% capacity
    if (queue.length >= maxQueueSize * 0.8) {
        logger.warn(`Render queue at ${queue.length}/${maxQueueSize} (>80%)`)
    }

    return new Promise<T>((resolve, reject) => {
        const item: QueueItem<T> = { priority, enqueuedAt: Date.now(), execute, resolve, reject }

        // Insert sorted: high priority first, then FIFO within same priority
        const insertIndex = priority === 'high'
            ? queue.findIndex(existing => existing.priority === 'low')
            : queue.length

        if (insertIndex === -1) {
            queue.push(item as QueueItem<unknown>)
        } else {
            queue.splice(insertIndex, 0, item as QueueItem<unknown>)
        }
    })
}

/**
 * Runs the task, then drains the next item from the queue when done.
 */
const executeAndDrain = async <T>(execute: () => Promise<T>): Promise<T> => {
    try {
        return await execute()
    } finally {
        activeCount--
        drainNext()
    }
}

const drainNext = (): void => {
    if (queue.length === 0 || activeCount >= parallelRenders) return

    const next = queue.shift()
    if (!next) return

    activeCount++

    executeAndDrain(next.execute).then(next.resolve, next.reject)
}

export const getQueueStats = (): { queueDepth: number; activeRenders: number } => {
    return { queueDepth: queue.length, activeRenders: activeCount }
}
