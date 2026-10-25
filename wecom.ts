/**
 * 企业微信文档「智能表格」同步后端（WeCom smartsheet client）。
 *
 * 接口：developer.work.weixin.qq.com 智能表格内容 API
 * - gettoken:        GET  /cgi-bin/gettoken?corpid=&corpsecret=
 * - 查询子表:        POST /cgi-bin/wedoc/smartsheet/get_sheet
 * - 查询记录:        POST /cgi-bin/wedoc/smartsheet/get_records （key_type=FIELD_TITLE，分页 offset/limit≤1000）
 * - 添加记录:        POST /cgi-bin/wedoc/smartsheet/add_records （返回 records[].record_id）
 * - 更新记录:        POST /cgi-bin/wedoc/smartsheet/update_records （records[] 带 record_id）
 *
 * 单元格约定：key 用字段标题；文本类值写作 [{type:'text',text}]；
 * 读取端把各种单元格形态（字符串/文本段数组/选项对象/数字/布尔）归一化为纯文本。
 */

import type { Task, TaskStatus, TaskPriority, WeComConfig } from './types.js'

const BASE = 'https://qyapi.weixin.qq.com/cgi-bin'
const TOKEN_TTL_MS = 7200 * 1000
const TOKEN_EARLY_REFRESH_MS = 300 * 1000

const DEFAULT_MAPPING = {
  title: '标题',
  description: '描述',
  status: '状态',
  priority: '优先级',
  tags: '标签',
  assignee: '负责人',
  dueDate: '截止日期',
  project: '项目',
}

const STATUS_MAP: Record<string, TaskStatus> = {
  '待规划': 'planned', '待办': 'todo', '进行中': 'in-progress',
  '评审中': 'review', '评审': 'review', '已完成': 'done', '完成': 'done',
  'planned': 'planned', 'todo': 'todo', 'in-progress': 'in-progress', 'review': 'review', 'done': 'done',
}
const STATUS_LABEL: Record<TaskStatus, string> = {
  'planned': '待规划', 'todo': '待办', 'in-progress': '进行中',
  'review': '评审中', 'done': '已完成',
}
const PRIORITY_MAP: Record<string, TaskPriority> = {
  '紧急': 'urgent', '高': 'high', '中': 'medium', '低': 'low',
  'urgent': 'urgent', 'high': 'high', 'medium': 'medium', 'low': 'low',
}
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  'urgent': '紧急', 'high': '高', 'medium': '中', 'low': '低',
}

/** Normalize one smartsheet cell value (string / segments / option / number / bool) to plain text. */
function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'text' in item) return String((item as { text?: unknown }).text ?? '')
      return ''
    }).join('').trim()
  }
  if (typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
    return String((value as { text?: unknown }).text ?? '')
  }
  return ''
}

function cellOptionText(value: unknown): string {
  if (Array.isArray(value)) return cellText(value)
  return cellText(value)
}

/** Text cell value for writes. */
function textCell(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

export class WeComClient {
  private readonly config: WeComConfig
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(config: WeComConfig) {
    this.config = config
  }

  private get mapping() {
    return { ...DEFAULT_MAPPING, ...this.config.fieldMapping }
  }

  /** Fetch + cache the corpid/secret access token (refreshes 5 min before expiry). */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_EARLY_REFRESH_MS) return this.token
    const url = `${BASE}/gettoken?corpid=${encodeURIComponent(this.config.corpid)}&corpsecret=${encodeURIComponent(this.config.corpsecret)}`
    const data = await this.http<{ errcode: number; errmsg: string; access_token?: string; expires_in?: number }>(url)
    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(`企微 gettoken 失败：${data.errcode} ${data.errmsg}`)
    }
    this.token = data.access_token
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000
    return this.token
  }

  private async http<T>(url: string, init?: { method?: string; body?: string }): Promise<T> {
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body,
    })
    if (!res.ok) throw new Error(`企微 API HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 300))
    return await res.json() as T
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.accessToken()
    const data = await this.http<T>(`${BASE}${path}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const errcode = (data as { errcode?: number }).errcode
    if (errcode !== 0 && errcode !== undefined) {
      throw new Error(`企微 API ${path} 失败：${errcode} ${(data as { errmsg?: string }).errmsg ?? ''}`.slice(0, 300))
    }
    return data
  }

  /** List the smartsheet sub-tables of the configured doc (first sheet wins when sheetId is unset). */
  async getSheets(): Promise<Array<{ sheet_id: string; title?: string }>> {
    const data = await this.post<{ sheets?: Array<{ sheet_id: string; title?: string }> }>(
      '/wedoc/smartsheet/get_sheet', { docid: this.config.docid })
    return data.sheets ?? []
  }

  private async sheetId(): Promise<string> {
    if (this.config.sheetId) return this.config.sheetId
    const sheets = await this.getSheets()
    if (sheets.length === 0) throw new Error('该文档下没有可用子表，请在配置中手动填写 sheetId')
    return sheets[0].sheet_id
  }

  /** Pull every record of the configured sheet as tasks (record_id becomes the task id). */
  async pullTasks(): Promise<Task[]> {
    const sheetId = await this.sheetId()
    const m = this.mapping
    const tasks: Task[] = []
    let offset = 0
    for (let page = 0; page < 100; page++) {
      const data = await this.post<{
        records?: Array<{ record_id: string; values: Record<string, unknown> }>
        has_more?: boolean
        next?: number
      }>('/wedoc/smartsheet/get_records', {
        docid: this.config.docid,
        sheet_id: sheetId,
        key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
        offset,
        limit: 1000,
      })
      for (const record of data.records ?? []) {
        const values = record.values ?? {}
        const statusText = cellOptionText(values[m.status ?? DEFAULT_MAPPING.status])
        const priorityText = cellOptionText(values[m.priority ?? DEFAULT_MAPPING.priority])
        tasks.push({
          id: record.record_id,
          title: cellText(values[m.title]) || '无标题',
          description: cellText(values[m.description]) || undefined,
          status: STATUS_MAP[statusText] ?? 'todo',
          priority: PRIORITY_MAP[priorityText] ?? 'medium',
          tags: [],
          assignee: cellText(values[m.assignee]) || undefined,
          project: cellText(values[m.project]) || undefined,
          dueDate: cellText(values[m.dueDate]) || undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          order: tasks.length,
        })
      }
      if (!data.has_more) break
      offset = data.next ?? (offset + 1000)
    }
    return tasks
  }

  /** Upsert one task back into the sheet (add when no remote record id is known). */
  async pushTask(task: Task): Promise<string> {
    const sheetId = await this.sheetId()
    const m = this.mapping
    const values: Record<string, unknown> = {
      [m.title]: textCell(task.title),
    }
    if (task.description) values[m.description] = textCell(task.description)
    if (task.status) values[m.status ?? DEFAULT_MAPPING.status] = textCell(STATUS_LABEL[task.status] ?? task.status)
    if (task.priority) values[m.priority ?? DEFAULT_MAPPING.priority] = textCell(PRIORITY_LABEL[task.priority] ?? task.priority)
    if (task.assignee) values[m.assignee] = textCell(task.assignee)
    if (task.project) values[m.project] = textCell(task.project)
    if (task.dueDate) values[m.dueDate] = task.dueDate

    const recordId = task.remoteRecordId
    if (recordId) {
      await this.post('/wedoc/smartsheet/update_records', {
        docid: this.config.docid,
        sheet_id: sheetId,
        key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
        records: [{ record_id: recordId, values }],
      })
      return recordId
    }
    const data = await this.post<{ records?: Array<{ record_id: string }> }>('/wedoc/smartsheet/add_records', {
      docid: this.config.docid,
      sheet_id: sheetId,
      key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
      records: [{ values }],
    })
    const newId = data.records?.[0]?.record_id
    if (!newId) throw new Error('企微 add_records 未返回 record_id')
    return newId
  }
}
