import { describe, expect, it } from 'vitest'
import { createKeyedQueues, createSerialQueue } from './queue'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('serial queue', () => {
  it('runs one task at a time, in order, and keeps going after a rejection', async () => {
    const q = createSerialQueue()
    let active = 0
    let maxActive = 0
    const order: number[] = []
    const task = (n: number, fail = false) => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(5)
      order.push(n)
      active--
      if (fail) throw new Error(`task ${n}`)
      return n
    }
    const ps = [q.run(task(1)), q.run(task(2, true)), q.run(task(3))]
    expect(q.length).toBe(3)
    const res = await Promise.allSettled(ps)
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(order).toEqual([1, 2, 3])
    expect(maxActive).toBe(1)
    expect(q.length).toBe(0)
  })
})

describe('keyed queues', () => {
  it('serialises per key and runs different keys side by side', async () => {
    const q = createKeyedQueues()
    const log: string[] = []
    const task = (k: string, n: number) => async () => {
      log.push(`start ${k}${n}`)
      await sleep(5)
      log.push(`end ${k}${n}`)
    }
    await Promise.all([q.run('a', task('a', 1)), q.run('a', task('a', 2)), q.run('b', task('b', 1))])
    expect(log.indexOf('end a1')).toBeLessThan(log.indexOf('start a2'))
    expect(log.indexOf('start b1')).toBeLessThan(log.indexOf('end a1'))
    expect(q.length).toBe(0)
  })
})
