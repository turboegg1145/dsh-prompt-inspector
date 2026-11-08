/**
 * Prompt Inspector — Client half.
 *
 * A drawer that reports what this harness injects before a conversation and
 * lets the reader trim it, per session:
 *   - every system-prompt section with its token estimate
 *   - every context block (working directory, sandbox policy, ...)
 *   - every tool schema the model will see
 *
 * The drawer lives in `shell.overlay` (frame-wide, click-through) and is opened
 * from a chip in `conversation.input.right`, which is where the live session id
 * arrives. All data comes from the plugin's own same-origin HTTP surface.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-inspector',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useSyncExternalStore } = React

    const NS = 'prompt-inspector'

    const DICT = {
      zh: {
        title: '提示词检查器',
        open: '提示词',
        close: '关闭',
        refresh: '刷新',
        loading: '加载中…',
        empty: '（空）',
        error: '出错了',
        sections: '系统提示词',
        contexts: '上下文注入',
        tools: '工具定义',
        total: '合计',
        rendered: '完整提示词',
        edited: '已修改',
        muted: '已静音',
        hidden: '已隐藏',
        edit: '编辑',
        save: '保存并应用',
        cancel: '取消',
        mute: '静音',
        revert: '恢复原始',
        hide: '隐藏',
        notRestrictable: '该工具由作用域注册，无法在此隐藏',
        noAgent: '这个会话还没有活动中的 agent，先发一条消息再看。',
        hint: '修改只影响后续请求，已经发生的对话不变。',
        busy: '应用中…',
        unsupported: '宿主未提供 web 路由',
      },
      en: {
        title: 'Prompt Inspector',
        open: 'Prompt',
        close: 'Close',
        refresh: 'Refresh',
        loading: 'Loading…',
        empty: '(empty)',
        error: 'Something went wrong',
        sections: 'System prompt',
        contexts: 'Context blocks',
        tools: 'Tool schemas',
        total: 'Total',
        rendered: 'Rendered prompt',
        edited: 'edited',
        muted: 'muted',
        hidden: 'hidden',
        edit: 'Edit',
        save: 'Save & apply',
        cancel: 'Cancel',
        mute: 'Mute',
        revert: 'Revert',
        hide: 'Hide',
        notRestrictable: 'Registered in an outer scope; cannot be hidden here',
        noAgent: 'This session has no live agent yet. Send a message first.',
        hint: 'Changes affect later requests only; the conversation so far is untouched.',
        busy: 'Applying…',
        unsupported: 'Host route unavailable',
      },
    }

    let translate = null

    function t(key) {
      if (translate) {
        try {
          const value = translate(key)
          if (typeof value === 'string' && value !== key) return value
        } catch {
          /* fall through */
        }
      }
      const lang = (typeof navigator !== 'undefined' && navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      return DICT[lang][key] || DICT.en[key] || key
    }

    let snap = {
      open: false,
      sessionId: null,
      data: null,
      loading: false,
      busy: false,
      error: null,
      notice: null,
      expanded: {},
      edits: {},
      hidden: {},
    }
    const listeners = new Set()

    function getSnap() {
      return snap
    }

    function set(patch) {
      snap = Object.assign({}, snap, patch)
      listeners.forEach((fn) => fn())
    }

    function subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }

    function useStore() {
      return useSyncExternalStore(subscribe, getSnap, getSnap)
    }

    function fmt(tokens) {
      if (!tokens) return '0'
      if (tokens < 1000) return String(tokens)
      return (tokens / 1000).toFixed(1) + 'k'
    }

    async function api(path, options) {
      const response = await fetch('/prompt-inspector' + path, Object.assign({
        credentials: 'same-origin',
        cache: 'no-store',
      }, options || {}))
      const raw = await response.text()
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = { error: raw }
      }
      if (!response.ok) {
        const error = new Error((body && body.error) || 'HTTP ' + response.status)
        error.known = body && body.known
        throw error
      }
      return body
    }

    function seed(data) {
      const edits = {}
      for (const row of data.sections || []) if (row.edited) edits[row.name] = row.text
      const hidden = {}
      for (const name of data.hidden || []) hidden[name] = true
      return { edits, hidden }
    }

    async function load(sessionId) {
      if (!sessionId) return
      set({ loading: true, error: null, notice: null })
      try {
        const data = await api('/snapshot?session=' + encodeURIComponent(sessionId))
        set(Object.assign({ loading: false, data, sessionId }, seed(data)))
      } catch (err) {
        set({ loading: false, error: String((err && err.message) || err), data: null })
      }
    }

    async function push() {
      const current = snap
      if (!current.data || !current.sessionId) return
      set({ busy: true, error: null, notice: null })
      try {
        const body = {
          sessionId: current.sessionId,
          edits: Object.keys(current.edits).map((name) => ({ name, text: current.edits[name] })),
          hidden: Object.keys(current.hidden).filter((name) => current.hidden[name]),
        }
        const data = await api('/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const problems = []
        if (data.errors && data.errors.length) problems.push(...data.errors)
        if (data.skippedTools && data.skippedTools.length) {
          problems.push(t('notRestrictable') + ': ' + data.skippedTools.join(', '))
        }
        set(Object.assign({ busy: false, data, notice: problems.length ? problems.join('; ') : null }, seed(data)))
      } catch (err) {
        set({ busy: false, error: String((err && err.message) || err) })
      }
    }

    function setEdit(name, text) {
      const edits = Object.assign({}, snap.edits)
      if (text === null) delete edits[name]
      else edits[name] = text
      set({ edits })
    }

    function toggleTool(name) {
      const hidden = Object.assign({}, snap.hidden)
      if (hidden[name]) delete hidden[name]
      else hidden[name] = true
      set({ hidden })
      push()
    }

    function toggleExpand(key) {
      const expanded = Object.assign({}, snap.expanded)
      expanded[key] = !expanded[key]
      set({ expanded })
    }

    // ---------------------------------------------------------------- styles

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      bg: 'var(--dsw-alias-bg-base)',
      panel: 'var(--dsw-alias-bg-layer-1)',
      sub: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
    }

    const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 26,
      padding: '0 9px',
      border: '1px solid ' + C.border,
      borderRadius: 999,
      background: 'transparent',
      color: C.dim,
      fontSize: 12,
      cursor: 'pointer',
      lineHeight: 1,
    }

    const panelStyle = {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      width: 'min(720px, 96vw)',
      display: 'flex',
      flexDirection: 'column',
      background: C.bg,
      borderLeft: '1px solid ' + C.border2,
      boxShadow: '-18px 0 48px rgba(0,0,0,0.18)',
      pointerEvents: 'auto',
      color: C.text,
      fontSize: 13,
    }

    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 12px',
      borderBottom: '1px solid ' + C.border,
      background: C.panel,
      flex: '0 0 auto',
    }

    const iconBtn = {
      border: '1px solid ' + C.border,
      background: 'transparent',
      color: C.dim,
      borderRadius: 6,
      width: 24,
      height: 24,
      cursor: 'pointer',
      lineHeight: 1,
      fontSize: 13,
      padding: 0,
    }

    const btnStyle = {
      border: '1px solid ' + C.border,
      background: 'transparent',
      color: C.text,
      borderRadius: 6,
      padding: '2px 8px',
      fontSize: 12,
      cursor: 'pointer',
    }

    const primaryBtn = Object.assign({}, btnStyle, {
      borderColor: C.brand,
      color: C.brand,
    })

    const textareaStyle = {
      width: '100%',
      minHeight: 160,
      resize: 'vertical',
      fontFamily: mono,
      fontSize: 12,
      lineHeight: 1.5,
      color: C.text,
      background: C.sub,
      border: '1px solid ' + C.border,
      borderRadius: 6,
      padding: 8,
      boxSizing: 'border-box',
    }

    const preStyle = {
      margin: 0,
      maxHeight: 260,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontFamily: mono,
      fontSize: 11.5,
      lineHeight: 1.55,
      color: C.dim,
      background: C.sub,
      border: '1px solid ' + C.border,
      borderRadius: 6,
      padding: 8,
    }

    function Tokens(props) {
      return h('span', {
        style: {
          fontVariantNumeric: 'tabular-nums',
          fontSize: 11,
          color: props.strong ? C.text : C.dim,
          background: C.sub,
          border: '1px solid ' + C.border,
          borderRadius: 999,
          padding: '1px 7px',
          whiteSpace: 'nowrap',
        },
      }, fmt(props.value) + ' tok')
    }

    function Badge(props) {
      return h('span', {
        style: {
          fontSize: 11,
          color: props.tone === 'warn' ? C.warn : C.dim,
          border: '1px solid ' + (props.tone === 'warn' ? C.warn : C.border),
          borderRadius: 999,
          padding: '0 6px',
          whiteSpace: 'nowrap',
        },
      }, props.children)
    }

    function groupTitle(text, sum) {
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px 4px',
          color: C.dim,
          fontSize: 11,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
        },
      }, h('span', null, text), h('span', { style: { flex: 1 } }), h(Tokens, { value: sum }))
    }

    // ------------------------------------------------------------ components

    function SectionRow(props) {
      const row = props.row
      const s = useStore()
      const key = 's:' + row.name
      const open = !!s.expanded[key]
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(row.text)

      useEffect(() => {
        setDraft(row.text)
        setEditing(false)
      }, [row.text])

      const head = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '6px 12px' },
        onClick: () => toggleExpand(key),
      },
        h('span', { style: { color: C.dim, fontSize: 10, width: 10 } }, open ? '▾' : '▸'),
        h('span', {
          style: { fontFamily: mono, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: row.name,
        }, row.name),
        row.muted ? h(Badge, { tone: 'warn' }, t('muted')) : null,
        row.edited && !row.muted ? h(Badge, null, t('edited')) : null,
        h('span', { style: { flex: 1 } }),
        h(Tokens, { value: row.tokens }),
      )

      const body = open ? h('div', { style: { padding: '0 12px 10px 28px' } },
        editing ? h('div', null,
          h('textarea', {
            value: draft,
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value),
            style: textareaStyle,
          }),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            h('button', {
              style: primaryBtn,
              onClick: () => {
                setEdit(row.name, draft)
                setEditing(false)
                push()
              },
            }, t('save')),
            h('button', {
              style: btnStyle,
              onClick: () => {
                setEditing(false)
                setDraft(row.text)
              },
            }, t('cancel')),
          ),
        ) : h('div', null,
          h('pre', { style: preStyle }, row.text || t('empty')),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            h('button', { style: btnStyle, onClick: () => setEditing(true) }, t('edit')),
            row.edited
              ? h('button', {
                  style: btnStyle,
                  onClick: () => {
                    setEdit(row.name, null)
                    push()
                  },
                }, t('revert'))
              : h('button', {
                  style: btnStyle,
                  onClick: () => {
                    setEdit(row.name, '')
                    push()
                  },
                }, t('mute')),
          ),
        ),
      ) : null

      return h('div', { style: { borderBottom: '1px solid ' + C.border } }, head, body)
    }

    function ContextRow(props) {
      const row = props.row
      const s = useStore()
      const key = 'c:' + row.name
      const open = !!s.expanded[key]
      return h('div', { style: { borderBottom: '1px solid ' + C.border } },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '6px 12px' },
          onClick: () => toggleExpand(key),
        },
          h('span', { style: { color: C.dim, fontSize: 10, width: 10 } }, open ? '▾' : '▸'),
          h('span', { style: { fontFamily: mono, fontSize: 12 } }, row.name),
          h('span', { style: { flex: 1 } }),
          h(Tokens, { value: row.tokens }),
        ),
        open ? h('div', { style: { padding: '0 12px 10px 28px' } }, h('pre', { style: preStyle }, row.text || t('empty'))) : null,
      )
    }

    function ToolRow(props) {
      const row = props.row
      const s = useStore()
      const key = 't:' + row.name
      const open = !!s.expanded[key]
      return h('div', { style: { borderBottom: '1px solid ' + C.border } },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '6px 12px' },
          onClick: () => toggleExpand(key),
        },
          h('input', {
            type: 'checkbox',
            checked: !!s.hidden[row.name],
            disabled: !row.restrictable,
            title: row.restrictable ? t('hide') : t('notRestrictable'),
            onClick: (event) => event.stopPropagation(),
            onChange: () => toggleTool(row.name),
            style: { margin: 0, accentColor: C.brand },
          }),
          h('span', {
            style: row.hidden
              ? { fontFamily: mono, fontSize: 12, color: C.dim, textDecoration: 'line-through' }
              : { fontFamily: mono, fontSize: 12 },
          }, row.name),
          row.hidden ? h(Badge, { tone: 'warn' }, t('hidden')) : null,
          h('span', { style: { flex: 1 } }),
          h(Tokens, { value: row.tokens }),
        ),
        open ? h('div', { style: { padding: '0 12px 10px 28px', display: 'flex', flexDirection: 'column', gap: 6 } },
          row.description ? h('div', { style: { color: C.dim, fontSize: 12, lineHeight: 1.5 } }, row.description) : null,
          h('pre', { style: preStyle }, JSON.stringify(row.parameters || {}, null, 2)),
        ) : null,
      )
    }

    function Totals(props) {
      const totals = props.totals
      const cell = (label, value, strong, note) => h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 62 },
      },
        h('span', { style: { fontSize: 10.5, color: C.dim, letterSpacing: 0.3 } }, label),
        h('span', {
          style: { fontSize: strong ? 17 : 14, fontWeight: strong ? 600 : 500, color: strong ? C.brand : C.text, fontVariantNumeric: 'tabular-nums' },
        }, fmt(value)),
        note ? h('span', { style: { fontSize: 10, color: C.warn } }, note) : null,
      )
      return h('div', {
        style: {
          display: 'flex',
          gap: 18,
          padding: '10px 12px',
          background: C.panel,
          borderBottom: '1px solid ' + C.border,
          flex: '0 0 auto',
        },
      },
        cell(t('sections'), totals.sections),
        cell(t('contexts'), totals.contexts),
        cell(t('tools'), totals.tools, false, totals.toolsHidden ? '−' + fmt(totals.toolsHidden) : null),
        h('div', { style: { flex: 1 } }),
        cell(t('total'), totals.all, true),
      )
    }

    function Drawer() {
      const s = useStore()

      useEffect(() => {
        if (!s.open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') set({ open: false })
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [s.open])

      if (!s.open) return null
      const data = s.data

      const body = s.loading
        ? h('div', { style: { padding: 24, color: C.dim } }, t('loading'))
        : s.error
          ? h('div', { style: { padding: 16, color: C.err, fontSize: 12, lineHeight: 1.6 } },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('error')),
              h('div', { style: { fontFamily: mono } }, s.error),
              h('div', { style: { color: C.dim, marginTop: 8 } }, t('noAgent')),
              h('button', { style: Object.assign({}, btnStyle, { marginTop: 10 }), onClick: () => load(s.sessionId) }, t('refresh')),
            )
          : data
            ? h('div', { style: { flex: '1 1 auto', overflow: 'auto' } },
                h(Totals, { totals: data.totals }),
                s.busy ? h('div', { style: { padding: '4px 12px', color: C.dim, fontSize: 11 } }, t('busy')) : null,
                s.notice ? h('div', { style: { padding: '6px 12px', color: C.warn, fontSize: 11.5, lineHeight: 1.5, borderBottom: '1px solid ' + C.border } }, s.notice) : null,
                groupTitle(t('sections'), data.totals.sections),
                data.sections.map((row) => h(SectionRow, { key: row.name, row })),
                groupTitle(t('contexts'), data.totals.contexts),
                data.contexts.map((row) => h(ContextRow, { key: row.name, row })),
                groupTitle(t('tools'), data.totals.tools),
                data.tools.map((row) => h(ToolRow, { key: row.name, row })),
                h('div', { style: { padding: '12px 12px 4px' } },
                  h('details', null,
                    h('summary', { style: { cursor: 'pointer', color: C.dim, fontSize: 11.5, letterSpacing: 0.3 } },
                      t('rendered') + ' · ' + fmt(data.totals.rendered) + ' tok'),
                    h('pre', { style: Object.assign({}, preStyle, { marginTop: 8, maxHeight: 420 }) }, data.rendered || t('empty')),
                  ),
                ),
                h('div', { style: { padding: '4px 12px 16px', color: C.dim, fontSize: 11, lineHeight: 1.5 } }, t('hint')),
              )
            : h('div', { style: { padding: 24, color: C.dim } }, t('loading'))

      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 2147483000, pointerEvents: 'none' } },
        h('div', {
          onClick: () => set({ open: false }),
          style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.18)', pointerEvents: 'auto' },
        }),
        h('aside', { style: panelStyle },
          h('div', { style: headerStyle },
            h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('title')),
            h('span', {
              style: { fontFamily: mono, fontSize: 11, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 },
              title: s.sessionId || '',
            }, (s.sessionId || '').slice(0, 18)),
            h('span', { style: { flex: 1 } }),
            h('button', {
              style: iconBtn,
              title: t('refresh'),
              onClick: () => load(s.sessionId),
            }, '↻'),
            h('button', {
              style: iconBtn,
              title: t('close'),
              onClick: () => set({ open: false }),
            }, '✕'),
          ),
          body,
        ),
      )
    }

    function Trigger(props) {
      const s = useStore()
      const sessionId = props.sessionId
      const active = s.open && s.sessionId === sessionId
      return h('button', {
        style: Object.assign({}, chipStyle, active ? { color: C.brand, borderColor: C.brand } : null),
        title: t('title'),
        onClick: () => {
          set({ open: true, sessionId })
          load(sessionId)
        },
      },
        h('svg', {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        },
          h('circle', { cx: 7, cy: 7, r: 4.2 }),
          h('path', { d: 'M10.2 10.2 14 14' }),
        ),
        h('span', null, t('open')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          translate = ctx.locale.bind(NS)
        } catch {
          translate = null
        }

        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en })
          } catch {
            return () => {}
          }
        }, 'prompt-inspector: dictionaries')

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'prompt-inspector.trigger',
          order: 20,
          inject: (sessionId) => ({ sessionId }),
        }, Trigger))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'prompt-inspector.drawer',
          order: 200,
        }, Drawer))
      },
    }
  },
})
