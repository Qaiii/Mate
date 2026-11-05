import React from 'react'

/**
 * Theme tokens come from the host: `--dsw-alias-label-*` for text,
 * `--dsw-alias-bg-*` for surfaces, `--dsw-alias-border-*` for dividers and
 * `--dsw-alias-state-*` for accents. Every rule states a fallback so a renamed
 * token degrades instead of rendering invisible text.
 */
export const STYLES = `
.mate-root {
  --mate-gap: 12px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 18px 22px 0;
  gap: 12px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
}
.mate-root * { box-sizing: border-box; }
.mate-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex: none;
}
.mate-title { display: flex; align-items: baseline; gap: 10px; }
.mate-title h1 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: 0.2px; color: var(--dsw-alias-label-primary, #0f1115); }
.mate-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.mate-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.32));
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit; font-size: 12.5px; line-height: 1.5;
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.mate-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.mate-btn:disabled { opacity: 0.55; cursor: default; }
.mate-btn.primary {
  border-color: transparent;
  /* Two declarations: if a theme token is missing or resolves invalid, the
     solid fallback below still paints the button. */
  background-color: #0f1115;
  background-color: var(--dsw-alias-button-primary-fill, #0f1115);
  color: #ffffff;
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
  font-weight: 600;
}
.mate-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
.mate-btn.danger { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c62828) 80%, var(--dsw-alias-label-primary, #0f1115)); }
.mate-btn.ghost { border-color: transparent; background: transparent; }
.mate-btn.ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.mate-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #247bbf); outline-offset: 1px; }

.mate-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; flex: none; }
.mate-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius: 9px; overflow: hidden; }
.mate-seg button {
  border: 0; background: transparent; font: inherit; font-size: 12.5px; cursor: pointer;
  padding: 5px 12px; color: var(--dsw-alias-label-secondary, #4b5563);
}
.mate-seg button.on { background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,0.16)); color: var(--dsw-alias-label-primary, #0f1115); font-weight: 600; }
.mate-chiprow { display: flex; gap: 6px; flex-wrap: wrap; }
.mate-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit; font-size: 12px;
}
.mate-chip.on {
  border-color: var(--dsw-alias-state-business-primary, #247bbf);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #247bbf) 16%, transparent);
}
.mate-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-business-primary, #247bbf); flex: none; }

.mate-input, .mate-select, .mate-textarea {
  width: 100%; min-width: 0; padding: 7px 10px;
  border-radius: 8px; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary, #0f1115);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.32));
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  outline: none;
}
.mate-input::placeholder, .mate-textarea::placeholder { color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-select option { background: var(--dsw-alias-bg-layer-2, #ffffff); color: var(--dsw-alias-label-primary, #0f1115); }
.mate-input:focus, .mate-select:focus, .mate-textarea:focus {
  border-color: var(--dsw-alias-state-business-primary, #247bbf);
}
.mate-textarea { resize: vertical; min-height: 84px; line-height: 1.55; }
.mate-select { cursor: pointer; }
.mate-filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; flex: none; }
.mate-filters .mate-select { width: auto; min-width: 130px; }
.mate-filters .mate-input { width: 220px; }

.mate-strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; flex: none; }
.mate-strip-item {
  display: flex; flex-direction: column; gap: 2px; min-width: 168px;
  padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.24));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 12px;
}
.mate-strip-item b { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mate-strip-item span { color: var(--dsw-alias-label-secondary, #4b5563); font-size: 11.5px; }

.mate-board { display: flex; gap: 10px; flex: 1; min-height: 0; overflow-x: auto; padding-bottom: 14px; align-items: stretch; }
.mate-col {
  display: flex; flex-direction: column; gap: 8px;
  flex: 1 1 0; min-width: 220px; max-width: 340px;
  padding: 10px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.16));
  overflow-y: auto;
}
.mate-col-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12.5px; font-weight: 600; position: sticky; top: 0; color: var(--dsw-alias-label-primary, #0f1115); }
.mate-count { font-weight: 500; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-empty { font-size: 12px; padding: 10px 4px; color: var(--dsw-alias-label-secondary, #4b5563); }

.mate-card {
  display: flex; flex-direction: column; gap: 6px; text-align: left; width: 100%;
  padding: 10px 11px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.26));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.10));
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
}
.mate-card:hover { border-color: var(--dsw-alias-state-business-primary, #247bbf); }
.mate-card-title { font-size: 13px; font-weight: 600; line-height: 1.42; }
.mate-card-meta, .mate-card-foot { display: flex; gap: 6px; flex-wrap: wrap; font-size: 11px; align-items: center; color: var(--dsw-alias-label-secondary, #4b5563); }

.mate-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 1.7;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
  color: var(--dsw-alias-label-secondary, #4b5563);
}
.mate-badge::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--badge-color, currentColor);
}
.mate-badge.auto { --badge-color: var(--dsw-alias-state-success-primary, #22a34a); }
.mate-badge.confirm { --badge-color: var(--dsw-alias-state-business-primary, #4176e6); }
.mate-badge.warn { --badge-color: var(--dsw-alias-state-warn-label, #dd8629); }
.mate-badge.error { --badge-color: var(--dsw-alias-state-error-primary, #c62828); }
.mate-badge.goal { --badge-color: var(--dsw-alias-state-warn-label, #dd8629); }

.mate-list { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; flex: 1; padding-bottom: 14px; }
.mate-row {
  display: flex; align-items: center; gap: 10px; text-align: left; width: 100%;
  padding: 9px 11px; border-radius: 9px; cursor: pointer; font: inherit;
  color: var(--dsw-alias-label-primary, #0f1115);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.05));
}
.mate-row:hover { border-color: var(--dsw-alias-state-business-primary, #247bbf); }
.mate-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mate-row-title { font-size: 13px; font-weight: 600; }
.mate-row-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #4b5563); }

.mate-backdrop {
  position: fixed; inset: 0; z-index: 60;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.38));
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.mate-dialog {
  display: flex; flex-direction: column; gap: 14px;
  width: min(760px, 92vw); max-height: 86vh; overflow: auto;
  padding: 18px 20px; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-3, #ffffff);
  color: var(--dsw-alias-label-primary, #0f1115);
  border: 1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3));
  box-shadow: 0 18px 48px rgba(0,0,0,0.34);
}
.mate-dialog.narrow { width: min(520px, 92vw); }
.mate-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mate-dialog-head h2 { margin: 0; font-size: 15.5px; font-weight: 650; color: var(--dsw-alias-label-primary, #0f1115); }
.mate-dialog-body { display: flex; flex-direction: column; gap: 12px; }
.mate-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.mate-field { display: flex; flex-direction: column; gap: 5px; }
.mate-field > label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-field .hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mate-grid3 { display: grid; grid-template-columns: 2fr 2fr 1fr; gap: 10px; }
.mate-check { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--dsw-alias-label-primary, #0f1115); }
.mate-check input[type="checkbox"] { accent-color: var(--dsw-alias-state-business-primary, #247bbf); width: 14px; height: 14px; }

.mate-drawer-backdrop { position: fixed; inset: 0; z-index: 50; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.3)); display: flex; justify-content: flex-end; }
.mate-drawer {
  width: min(680px, 94vw); height: 100%; overflow-y: auto;
  padding: 18px 20px 28px; display: flex; flex-direction: column; gap: 14px;
  background: var(--dsw-alias-bg-layer-3, #ffffff);
  color: var(--dsw-alias-label-primary, #0f1115);
  border-left: 1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3));
}
.mate-section { display: flex; flex-direction: column; gap: 8px; }
.mate-section > h3 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-panel {
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.24));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
}
.mate-prose { font-size: 12.8px; line-height: 1.62; white-space: pre-wrap; word-break: break-word; }
.mate-items { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.6; }
.mate-items li { margin: 2px 0; }
.mate-kv { display: flex; gap: 8px; font-size: 12px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.mate-thread { display: flex; flex-direction: column; gap: 8px; }
.mate-msg { padding: 8px 10px; border-radius: 9px; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.mate-msg.user {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #247bbf) 16%, transparent);
  align-self: flex-end; max-width: 88%;
}
.mate-msg.mate { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1)); max-width: 92%; }
.mate-msg-role { font-size: 10.5px; margin-bottom: 3px; color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-errors { font-size: 11.5px; display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary, #4b5563); }
.mate-error-line { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c62828) 80%, var(--dsw-alias-label-primary, #0f1115)); }
.mate-spinner {
  width: 15px; height: 15px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
  border-top-color: var(--dsw-alias-state-business-primary, #247bbf);
  animation: mate-spin 0.8s linear infinite;
}
@keyframes mate-spin { to { transform: rotate(360deg); } }
.mate-notice {
  position: sticky; bottom: 8px; align-self: center;
  padding: 7px 14px; border-radius: 999px; font-size: 12px;
  border: 1px solid transparent;
  background: var(--dsw-alias-toast-bg, #353638);
  /* The toast surface is dark in both themes, so it needs the toast label, not
     the page text color. */
  color: var(--dsw-alias-toast-label, #ffffff);
  box-shadow: 0 8px 24px rgba(0,0,0,0.28);
}
.mate-notice.error { color: #ff9d9d; }
`

export function Spinner(): React.ReactElement {
  return <span className="mate-spinner" role="status" aria-label="loading" />
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  busy?: boolean
}

export function Button({ variant = 'default', busy = false, disabled, children, ...rest }: ButtonProps): React.ReactElement {
  const className = ['mate-btn', variant === 'default' ? '' : variant, rest.className ?? ''].filter(Boolean).join(' ')
  return (
    <button {...rest} className={className} disabled={disabled === true || busy}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  )
}

export function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="mate-field">
      <label>{label}</label>
      {children}
      {hint !== undefined ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

export function Badge({ tone = '', children }: { tone?: '' | 'auto' | 'confirm' | 'warn' | 'error' | 'goal'; children: React.ReactNode }): React.ReactElement {
  return <span className={`mate-badge ${tone}`.trim()}>{children}</span>
}

export function EmptyState({ title, hint, action }: {
  title: string
  hint?: string
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="mate-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      {hint !== undefined ? <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #4b5563)' }}>{hint}</span> : null}
      {action}
    </div>
  )
}

/** Accessible modal: Escape closes, focus moves in, backdrop click closes. */
export function Modal({ title, onClose, children, footer, narrow = false }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  narrow?: boolean
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    const focusable = ref.current?.querySelector<HTMLElement>('input, textarea, select, button')
    focusable?.focus()
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [onClose])

  return (
    <div className="mate-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={`mate-dialog${narrow ? ' narrow' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="mate-dialog-head">
          <h2>{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="close">✕</Button>
        </div>
        <div className="mate-dialog-body">{children}</div>
        {footer !== undefined ? <div className="mate-dialog-foot">{footer}</div> : null}
      </div>
    </div>
  )
}


