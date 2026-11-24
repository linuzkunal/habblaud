// Staff bar (fork): replaces the usage cards in the top bar with two big buttons.
//   On-board employee  → opens the New agent form (SpawnPanel): a new infiniacode (or Claude Code) session.
//   Off-board employee → a list of the infiniacode employees in the office; pick one, confirm, and the session is
//                        interrupted and archived (POST /api/opencode/agents/:id/stop). Archived, not deleted.
import type { AgentInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import { access } from '../net/access';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { statusLabel } from './model';

const CONFIRM_MS = 4000;

function bigButton(icon: string, title: string, sub: string, onClick: () => void): HTMLButtonElement {
  const glyph = h('span', { class: 'ui-staff__icon', attrs: { 'aria-hidden': 'true' } });
  glyph.textContent = icon;
  return h(
    'button',
    { class: 'ui-usage-card ui-staff__btn', type: 'button', on: { click: onClick } },
    glyph,
    h('span', { class: 'ui-staff__text' }, h('span', { class: 'ui-staff__title', text: title }), h('span', { class: 'ui-staff__sub', text: sub })),
  );
}

export class StaffBar {
  readonly el: HTMLElement;
  readonly onboardBtn: HTMLButtonElement;
  private readonly offboardBtn: HTMLButtonElement;
  private readonly picker: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private confirmId?: string;
  private confirmTimer?: number;

  constructor(
    private readonly ctx: UiContext,
    openOnboard: (anchor: HTMLElement) => void,
  ) {
    this.onboardBtn = bigButton('➕', tr('Contratar funcionário'), tr('Começa uma sessão nova num projeto'), () => openOnboard(this.onboardBtn));
    this.onboardBtn.setAttribute('aria-haspopup', 'dialog');
    this.offboardBtn = bigButton('👋', tr('Desligar funcionário'), tr('Para e arquiva uma sessão do infiniacode'), () => this.toggle());
    this.offboardBtn.setAttribute('aria-haspopup', 'dialog');
    this.el = h('div', { class: 'ui-usage ui-staff', role: 'group', attrs: { 'aria-label': tr('Equipe') } }, this.onboardBtn, this.offboardBtn);

    this.list = h('ul', { class: 'ui-staff__list' });
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm');
    this.picker = h(
      'div',
      { class: 'ui-popover ui-spawn', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Desligar funcionário'), popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Desligar funcionário') }), close),
      h(
        'div',
        { class: 'ui-set-group ui-spawn__body' },
        h('p', { class: 'ui-rename__hint', text: tr('Interrompe o que a sessão está fazendo e a arquiva (não apaga: dá para restaurar no infiniacode). Clique duas vezes para confirmar.') }),
        this.list,
        this.status,
      ),
    );
    ctx.root.append(this.picker);
  }

  private get isOpen(): boolean {
    try {
      return this.picker.matches(':popover-open');
    } catch {
      return this.picker.classList.contains('is-open');
    }
  }

  private employees(): AgentInfo[] {
    return (this.ctx.store.snapshot?.agents ?? []).filter(
      (a) => a.provider === 'opencode' && a.kind === 'main' && a.status !== 'offline' && a.status !== 'done',
    );
  }

  private toggle(): void {
    if (this.isOpen) return this.hide();
    this.renderList();
    setText(this.status, '');
    const r = this.offboardBtn.getBoundingClientRect();
    this.picker.style.top = `${Math.round(r.bottom + 8)}px`;
    this.picker.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.picker.showPopover === 'function') this.picker.showPopover();
    else this.picker.classList.add('is-open');
  }

  private hide(): void {
    if (typeof this.picker.hidePopover === 'function' && this.isOpen) this.picker.hidePopover();
    this.picker.classList.remove('is-open');
    this.confirmId = undefined;
  }

  private renderList(): void {
    this.list.replaceChildren();
    const people = this.employees();
    if (!people.length) {
      this.list.append(h('li', { class: 'ui-rename__hint', text: tr('Nenhum funcionário do infiniacode no escritório agora.') }));
      return;
    }
    for (const a of people) {
      const room = this.ctx.store.room(a.roomId)?.name ?? a.roomId;
      const btn = h('button', {
        class: 'ui-btn ui-btn--sm',
        type: 'button',
        text: this.confirmId === a.id ? tr('Confirmar?') : tr('Desligar'),
        on: { click: () => void this.offboard(a) },
      });
      if (this.confirmId === a.id) btn.classList.add('is-on');
      this.list.append(
        h(
          'li',
          { class: 'ui-staff__row' },
          h('span', { class: 'ui-staff__who' }, h('b', { text: a.name }), h('span', { text: ` · ${room} · ${statusLabel(a.status)}` })),
          btn,
        ),
      );
    }
  }

  private async offboard(a: AgentInfo): Promise<void> {
    if (this.confirmId !== a.id) {
      this.confirmId = a.id;
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => {
        this.confirmId = undefined;
        if (this.isOpen) this.renderList();
      }, CONFIRM_MS);
      return this.renderList();
    }
    window.clearTimeout(this.confirmTimer);
    this.confirmId = undefined;
    setText(this.status, tr('Desligando {0}…', [a.name]));
    try {
      const res = await fetch(`/api/opencode/agents/${encodeURIComponent(a.sessionId)}/stop`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setText(this.status, tr('{0} foi desligado (sessão arquivada). Sai do escritório em instantes.', [a.name]));
      this.ctx.announce(tr('{0} foi desligado.', [a.name]));
    } catch (err) {
      this.status.classList.add('is-error');
      setText(this.status, tr('Não desligou: {0}', [(err as Error).message]));
    }
    this.renderList();
  }

  render(): void {
    const a = access();
    const store = this.ctx.store;
    const off = !!store.mock || !!store.replaying;
    const noOn = !(a.spawn || a.opencodeSpawn) || off;
    const noOff = !a.opencodeSpawn || off;
    setHidden(this.onboardBtn, noOn);
    setHidden(this.offboardBtn, noOff);
    setHidden(this.el, noOn && noOff);
    if (this.isOpen && !this.confirmId) this.renderList();
  }
}
