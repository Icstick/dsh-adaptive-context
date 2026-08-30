// client/index.js — dsh-adaptive-context 设置页卡片（bundle-ready CJS 风格源码）。
//
// 构建：node client/build.mjs → lib/client.js（window.__ModuleLoader__.load 闭包）。
// dsh.client.inject 声明包关系；Cordis 服务依赖由下方 exports.inject 声明并控制激活。
// react 由平台预加载，ui-slots 提供 ctx.slots，ui-settings 提供 ctx.settingsScope。
// 自包含：不依赖 ui-settings-plugins 私有表单，字段渲染 + staged 草稿 + 保存自实现。
// 文案写死中文（v1 不做 i18n）。

const { h, useState, useSyncExternalStore } = require('react')

/** 设置页 namespace（与 host 侧 SETTINGS_NAMESPACE 一致） */
const NS = 'adaptive-context'

/** 卡片标题/描述 */
const TITLE = '自适应上下文（ACP）'
const DESC = '证据账本 · 上下文注入 · 会话隔离'

/**
 * 字段定义（顺序即渲染顺序）。
 * type: text | number | select | toggle
 * options: select 的可选项
 */
const FIELDS = [
  { name: 'ledgerDir', label: '数据目录', hint: '证据账本 SQLite 所在目录（重启生效）', type: 'text' },
  { name: 'hotTokens', label: '热路径注入预算', hint: '每轮注入 token 上限', type: 'number' },
  { name: 'recallLimit', label: '召回上限', hint: '每个记忆源的候选上限', type: 'number' },
  {
    name: 'targetDomain', label: '目标领域', hint: '默认注入目标领域', type: 'select',
    options: ['work', 'user_fact', 'user_preference', 'experience', 'style', 'external_fact'],
  },
  {
    name: 'crossSessionPolicy', label: '跨会话注入策略', type: 'select',
    hint: 'non-instructional=跨会话只注入非指令性内容；all=全类别+降权；none=不注入跨会话',
    options: ['non-instructional', 'all', 'none'],
  },
  { name: 'subagentDowngrade', label: '子代理会话降权', hint: '父 agent 派发的 prompt 不冒充用户指令', type: 'toggle' },
  { name: 'memosEnabled', label: 'MemOS 记忆源', type: 'toggle' },
  { name: 'memosBaseUrl', label: 'MemOS 地址', type: 'text' },
  { name: 'consolidationProvider', label: '沉淀模型服务商', type: 'text' },
  { name: 'consolidationModel', label: '沉淀模型', type: 'text' },
  { name: 'autoPromote', label: '自动提升', hint: '风格候选策略达标后自动晋升', type: 'toggle' },
  { name: 'debug', label: '调试日志', type: 'toggle' },
]

/** 字段值 → 草稿文本（渲染初始值） */
function draftOf(value) {
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (value === null || value === undefined) return ''
  return String(value)
}

/** 草稿文本 → 写入值；空 → null（表示 unset） */
function parseDraft(field, text) {
  const trimmed = String(text ?? '').trim()
  if (field.type === 'number') {
    if (trimmed === '') return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : undefined // undefined = 非法，阻止保存
  }
  if (field.type === 'toggle') return trimmed === 'true'
  if (trimmed === '') return null
  return trimmed
}

const rowStyle = {
  display: 'flex', flexDirection: 'column', gap: '4px',
  padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
}
const labelStyle = { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #1f2937)' }
const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' }
const inputStyle = {
  fontSize: '13px', padding: '4px 8px', borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
  background: 'var(--dsw-alias-field-bg, #fff)', color: 'var(--dsw-alias-label-primary, #111827)',
}
const badgeStyle = {
  fontSize: '11px', color: '#b45309', background: '#fef3c7',
  borderRadius: '999px', padding: '1px 8px', marginLeft: '8px',
}
const resetBtnStyle = {
  fontSize: '12px', color: '#b45309', background: 'none', border: 'none',
  cursor: 'pointer', textDecoration: 'underline', padding: 0,
}

/**
 * 单字段控件：label + hint + 覆盖徽标 + 输入控件 + 重置。
 * @param {object} p - { field, value, draft, overridden, disabled, onDraft, onReset }
 */
function FieldControl(p) {
  const { field, value, draft, overridden, disabled, onDraft, onReset } = p
  const text = draft !== undefined ? draft : draftOf(value)
  const common = {
    id: 'acp-field-' + field.name,
    disabled,
    style: inputStyle,
    value: field.type === 'toggle' ? (text === 'true') : text,
  }
  let control
  if (field.type === 'toggle') {
    control = h('input', {
      ...common,
      type: 'checkbox',
      checked: text === 'true',
      onChange: (e) => onDraft(String(e.target.checked)),
    })
  } else if (field.type === 'select') {
    control = h('select', {
      ...common,
      onChange: (e) => onDraft(e.target.value),
    }, (field.options ?? []).map((opt) =>
      h('option', { key: opt, value: opt }, opt)))
  } else {
    control = h('input', {
      ...common,
      type: field.type === 'number' ? 'number' : 'text',
      onChange: (e) => onDraft(e.target.value),
    })
  }
  return h('div', { style: rowStyle },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
      h('label', { htmlFor: common.id, style: labelStyle }, field.label),
      overridden ? h('span', { style: badgeStyle }, '已覆盖') : null),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, control,
      overridden ? h('button', { type: 'button', style: resetBtnStyle, disabled, onClick: onReset }, '重置') : null),
    field.hint ? h('div', { style: hintStyle }, field.hint) : null)
}

/**
 * 设置卡片组件（自包含：闭包捕获 bound scope）。
 * @param {object} scope - ctx.settingsScope.bind({namespace}) 结果
 */
function makeCard(scope) {
  return function Card() {
    const snapshot = useSyncExternalStore(
      (cb) => scope.subscribe(cb),
      () => scope.getSnapshot(),
    )
    const value = snapshot?.value && typeof snapshot.value === 'object' ? snapshot.value : {}
    const userLayer = snapshot?.user && typeof snapshot.user === 'object' ? snapshot.user : {}
    const writable = snapshot?.writable === true
    const [drafts, setDrafts] = useState(null) // null=无编辑；{name: text}
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)

    const dirty = drafts !== null
    const invalid = dirty && FIELDS.some((f) =>
      drafts[f.name] !== undefined && parseDraft(f, drafts[f.name]) === undefined)

    async function save() {
      if (!dirty || invalid || saving) return
      setSaving(true); setFailed(false)
      try {
        const writes = []
        for (const field of FIELDS) {
          if (!(field.name in drafts)) continue
          const parsed = parseDraft(field, drafts[field.name])
          if (parsed === undefined) continue
          if (parsed === null) writes.push(scope.unset(field.name))
          else writes.push(scope.set(field.name, parsed))
        }
        await Promise.all(writes)
        setDrafts(null)
      } catch {
        setFailed(true)
      } finally {
        setSaving(false)
      }
    }

    function discard() { setDrafts(null); setFailed(false) }
    function onDraft(name, text) {
      setFailed(false)
      setDrafts((prev) => {
        const next = { ...(prev ?? {}) }
        next[name] = text
        return next
      })
    }
    function onReset(name) {
      setFailed(false)
      setDrafts((prev) => {
        const next = { ...(prev ?? {}) }
        next[name] = '' // 空草稿 = unset
        return next
      })
    }

    const headerStyle = {
      display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
      background: 'none', border: 'none', cursor: 'pointer', padding: '12px 4px',
      textAlign: 'left', font: 'inherit',
    }
    return h('li', { style: { listStyle: 'none' } },
      h('button', {
        type: 'button', style: headerStyle, 'aria-expanded': open,
        'aria-label': (open ? '收起设置: ' : '展开设置: ') + TITLE,
        onClick: () => setOpen(!open),
      },
        h('span', { style: { fontWeight: 600, fontSize: '14px', color: 'var(--dsw-alias-label-primary, #111827)' } }, TITLE),
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, DESC),
        dirty ? h('span', { style: badgeStyle }, '未保存') : null,
        h('span', { style: { marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none' } }, '▾')),
      open ? h('div', { style: { padding: '0 4px 12px' } },
        !writable ? h('p', { role: 'status', style: hintStyle }, '当前文档不可写（只读模式）') : null,
        FIELDS.map((field) => h(FieldControl, {
          key: field.name,
          field,
          value: value[field.name],
          draft: drafts ? drafts[field.name] : undefined,
          overridden: userLayer[field.name] !== undefined,
          disabled: !writable || saving,
          onDraft: (text) => onDraft(field.name, text),
          onReset: () => onReset(field.name),
        })),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', paddingTop: '12px' } },
          failed ? h('p', { role: 'status', style: { ...hintStyle, color: '#b91c1c', marginRight: 'auto', alignSelf: 'center' } }, '保存失败，请重试') : null,
          h('button', {
            type: 'button', disabled: !dirty || saving,
            style: { ...inputStyle, background: 'none', color: '#6b7280', cursor: 'pointer' },
            onClick: discard,
          }, '放弃'),
          h('button', {
            type: 'button', disabled: !dirty || invalid || saving,
            style: {
              ...inputStyle, cursor: 'pointer', fontWeight: 600,
              background: 'var(--dsw-alias-accent, #2563eb)', color: '#fff', borderColor: 'transparent',
            },
            onClick: save,
          }, saving ? '保存中…' : '保存')))
        : null)
  }
}

/** client 插件入口：注册设置卡片（keyed by namespace）。 */
function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: NS })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: NS },
    makeCard(scope),
  ))
}

exports.inject = ['slots', 'settingsScope']
// build.mjs 模板注入 exports.apply
exports.apply = apply
