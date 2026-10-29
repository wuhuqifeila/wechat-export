import { describe, expect, it } from 'vitest'
import { todaySyncExport } from './syncExportOptions'
describe('explicit single-session today export', () => {
  it('rejects absent session and relative output', () => {
    expect(() => todaySyncExport('', 'C:/exports')).toThrow()
    expect(() => todaySyncExport('a@chatroom', 'relative')).toThrow()
  })
  it('uses local midnight and one fixed end time', () => {
    const now = new Date(2026, 9, 30, 10, 20, 30)
    const result = todaySyncExport('a@chatroom', 'C:/exports', now)
    expect(result.options.dateRange).toEqual({ start: new Date(2026,9,30).getTime()/1000, end: now.getTime()/1000 })
    expect(result.sessionId).toBe('a@chatroom')
  })
  it('rolls to a new day and does not silently export unlimited history', () => {
    const now=new Date(2026,10,1,0,0,1)
    const result=todaySyncExport('one','C:/exports',now)
    expect(result.options.dateRange!.end-result.options.dateRange!.start).toBe(1)
  })
  it('keeps media limits and never enables source verification or writes', () => {
    const {options}=todaySyncExport('one','C:/exports')
    expect(options.exportFiles).toBe(true)
    expect(options.exportImages).toBe(true)
    expect(options.maxFileSizeMb).toBe(5)
    expect(options.verifyAfterExport).toBe(false)
  })
})
