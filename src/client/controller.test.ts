import { describe, expect, it } from 'vitest'
import { MAX_QUEUE_LENGTH } from '../shared.js'
import { MateRequestError } from './api.js'
import { commandErrorCode, commandErrorMessage } from './controller.js'

describe('command error copy', () => {
  it('maps queue-full onto localized copy using the shared queue limit', () => {
    const zh = commandErrorMessage(new MateRequestError('queue-full', 'the queue is full'), () => 'zh')
    expect(zh).toBe(`排队队列已满（上限 ${MAX_QUEUE_LENGTH} 条），请等已排队需求开始后再提交`)
    expect(zh).toContain('50')

    const en = commandErrorMessage(new MateRequestError('queue-full', 'the queue is full'), () => 'en-US')
    expect(en).toContain(`limit ${MAX_QUEUE_LENGTH}`)
    expect(en).not.toBe('the queue is full')
  })

  it('leaves every other command error message unchanged', () => {
    expect(commandErrorMessage(new MateRequestError('schedule-invalid', 'bad schedule'), () => 'zh'))
      .toBe('bad schedule')
    expect(commandErrorMessage(new Error('boom'), () => 'zh')).toBe('boom')
    expect(commandErrorMessage('plain failure', () => 'en')).toBe('plain failure')
  })

  it('reads a stable machine code, if the error carries one', () => {
    expect(commandErrorCode(new MateRequestError('queue-full', 'full'))).toBe('queue-full')
    expect(commandErrorCode({ code: 'queue-full' })).toBe('queue-full')
    expect(commandErrorCode({ code: '' })).toBeNull()
    expect(commandErrorCode(new Error('no code'))).toBeNull()
    expect(commandErrorCode(null)).toBeNull()
    expect(commandErrorCode(undefined)).toBeNull()
  })
})
