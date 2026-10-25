/**
 * Remote sync configuration dialog (Feishu bitable / WeCom smartsheet) —
 * native controls, host-themed via kanban.css.
 */
import { useState, useEffect } from 'react'
import type { FeishuConfig, WeComConfig, SyncBackend } from '../api'
import { kanbanApi } from '../api'
import { Modal, Field } from './ui'
import { IconCloud } from './icons'

interface FeishuDialogProps {
  open: boolean
  onClose: () => void
  onSyncComplete: () => void
}

const STORAGE_KEY = 'dsh-kanban-feishu-config'

export function SyncDialog({ open, onClose, onSyncComplete }: FeishuDialogProps) {
  const [backend, setBackend] = useState<SyncBackend>('feishu')
  const [feishuCfg, setFeishuCfg] = useState<FeishuConfig>({
    appId: '',
    appSecret: '',
    bitableAppToken: '',
    tableId: '',
  } as FeishuConfig)
  const [wecomCfg, setWecomCfg] = useState<WeComConfig>({
    corpid: '',
    corpsecret: '',
    docid: '',
    sheetId: '',
    autoSyncMinutes: 0,
  })
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    // Prefer the server-side config (SQLite); fall back to the local copy.
    const loadLocal = () => {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        try { setFeishuCfg(JSON.parse(saved)) } catch { /* ignore */ }
      }
    }
    kanbanApi
      .getSyncBackend()
      .then((b) => { if (!cancelled) setBackend(b) })
      .catch(() => { /* default feishu */ })
    kanbanApi
      .feishuGetConfig()
      .then((cfg) => {
        if (cancelled) return
        if (cfg) setFeishuCfg(cfg)
        else loadLocal()
      })
      .catch(() => { if (!cancelled) loadLocal() })
    kanbanApi
      .wecomGetConfig()
      .then((cfg) => { if (!cancelled && cfg) setWecomCfg(cfg) })
      .catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [open])

  const setFeishu = (key: keyof FeishuConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFeishuCfg((prev) => ({ ...prev, [key]: e.target.value }))

  const setWecom = (key: keyof WeComConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setWecomCfg((prev) => ({ ...prev, [key]: e.target.value }))

  const backendLabel = backend === 'wecom' ? '企业微信' : '飞书'

  const handleSaveConfig = async () => {
    setSaving(true)
    setNotice(null)
    try {
      if (backend === 'wecom') {
        await kanbanApi.wecomSaveConfig(wecomCfg)
      } else {
        // feishuSaveConfig posts to the server (SQLite) and mirrors to localStorage
        await kanbanApi.feishuSaveConfig(feishuCfg)
      }
      await kanbanApi.setSyncBackend(backend)
      setNotice({ type: 'success', text: `配置已保存（${backendLabel}，已写入服务端，重启后仍有效）` })
    } catch (err: any) {
      setNotice({ type: 'error', text: err.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const handleImport = async () => {
    setImporting(true)
    setNotice(null)
    try {
      const result = await kanbanApi.syncPull()
      setNotice({ type: 'success', text: result.message || '导入成功' })
      onSyncComplete()
    } catch (err: any) {
      setNotice({ type: 'error', text: err.message || '导入失败' })
    } finally {
      setImporting(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    setNotice(null)
    try {
      const result = await kanbanApi.syncPush()
      setNotice({ type: 'success', text: result.message || '导出成功' })
    } catch (err: any) {
      setNotice({ type: 'error', text: err.message || '导出失败' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Modal
      open={open}
      title="远端任务同步"
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="kb-btn" onClick={handleSaveConfig} disabled={saving}>
            {saving ? '保存中…' : '保存配置'}
          </button>
          <span className="kb-spacer" />
          <button className="kb-btn" onClick={handleExport} disabled={exporting}>
            {exporting ? '导出中…' : `导出到${backendLabel}`}
          </button>
          <button
            className="kb-btn kb-btn-primary"
            onClick={handleImport}
            disabled={importing}
          >
            <IconCloud size={13} />
            {importing ? '导入中…' : `从${backendLabel}导入`}
          </button>
        </>
      }
    >
      <Field label="同步后端">
        <select
          className="kb-input"
          value={backend}
          onChange={(e) => { setBackend(e.target.value as SyncBackend); setNotice(null) }}
        >
          <option value="feishu">飞书多维表格</option>
          <option value="wecom">企业微信文档（智能表格）</option>
        </select>
      </Field>

      {backend === 'feishu' ? (
        <>
          <Field label="App ID">
            <input
              className="kb-input"
              value={feishuCfg.appId}
              onChange={setFeishu('appId')}
              placeholder="飞书应用 App ID"
            />
          </Field>
          <Field label="App Secret">
            <input
              className="kb-input"
              type="password"
              value={feishuCfg.appSecret}
              onChange={setFeishu('appSecret')}
              placeholder="飞书应用 App Secret"
            />
          </Field>
          <Field label="Bitable App Token">
            <input
              className="kb-input"
              value={feishuCfg.bitableAppToken}
              onChange={setFeishu('bitableAppToken')}
              placeholder="多维表格 appToken"
            />
          </Field>
          <Field label="Table ID">
            <input
              className="kb-input"
              value={feishuCfg.tableId}
              onChange={setFeishu('tableId')}
              placeholder="数据表 ID"
            />
          </Field>
          <Field label="自动拉取间隔（分钟）">
            <input
              className="kb-input"
              type="number"
              min={0}
              max={1440}
              value={feishuCfg.autoSyncMinutes ?? 0}
              onChange={(e) => setFeishuCfg((prev) => ({ ...prev, autoSyncMinutes: Number(e.target.value) || 0 }))}
              placeholder="0 表示关闭"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Corp ID">
            <input
              className="kb-input"
              value={wecomCfg.corpid}
              onChange={setWecom('corpid')}
              placeholder="企业 ID"
            />
          </Field>
          <Field label="应用 Secret">
            <input
              className="kb-input"
              type="password"
              value={wecomCfg.corpsecret}
              onChange={setWecom('corpsecret')}
              placeholder="自建应用 Secret（需文档权限）"
            />
          </Field>
          <Field label="文档 docid">
            <input
              className="kb-input"
              value={wecomCfg.docid}
              onChange={setWecom('docid')}
              placeholder="智能表格所在文档 docid"
            />
          </Field>
          <Field label="子表 sheet_id（可选）">
            <input
              className="kb-input"
              value={wecomCfg.sheetId ?? ''}
              onChange={setWecom('sheetId')}
              placeholder="留空自动使用第一个子表"
            />
          </Field>
          <Field label="自动拉取间隔（分钟）">
            <input
              className="kb-input"
              type="number"
              min={0}
              max={1440}
              value={wecomCfg.autoSyncMinutes ?? 0}
              onChange={(e) => setWecomCfg((prev) => ({ ...prev, autoSyncMinutes: Number(e.target.value) || 0 }))}
              placeholder="0 表示关闭"
            />
          </Field>
        </>
      )}

      {notice && (
        <div
          className={notice.type === 'error' ? 'kb-error' : 'kb-hint'}
          style={notice.type === 'success' ? { color: 'var(--dsw-alias-state-success-primary, #10b981)' } : undefined}
        >
          {notice.text}
        </div>
      )}

      <div className="kb-hint">
        列映射默认按列标题匹配：标题 / 描述 / 状态 / 优先级 / 负责人 / 截止日期 / 项目。
        导入会覆盖看板中的任务（状态以看板为准）；AI 完成任务工作后会自动把结果推回远端。
      </div>
    </Modal>
  )
}
