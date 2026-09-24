'use strict';
function ReferrerWidget() {
  const self = this;
  const core = createReferrerCore();
  let state = null;
  function destroy() {
    if (state) {
      state.dead = true;
      state.seq++;
      clearTimeout(state.timer);
      state.api.stop();
      if (state.card) state.card.offChange(state.onChange);
      state.root.off('.referrer').remove();
      state = null;
    }
  }
  function mount() {
    destroy();
    const app = window.APP;
    if (!app || !app.isCard() || app.getBaseEntity() !== 'leads') return true;
    self.render_template({caption: {class_name: 'personal-referrer-caption', html: 'Рекомендатель'},
      body: '', render: '<div class="personal-referrer"></div>'});
    const root = $('.personal-referrer').last();
    const cssId = 'personal-referrer-css';
    if (!document.getElementById(cssId)) {
      $('<link>', {id: cssId, rel: 'stylesheet', href: self.params.path + '/style.css?v=' + self.get_version()}).appendTo('head');
    }
    const searchId = 'personal-referrer-search';
    root.append($('<label>', {for: searchId, text: 'Рекомендатель'}));
    const selected = $('<div>', {class: 'personal-referrer-selected'}).appendTo(root);
    const search = $('<input>', {id: searchId, type: 'search', placeholder: 'Имя или телефон — от 2 символов',
      autocomplete: 'off', 'aria-label': 'Поиск рекомендателя', disabled: true}).appendTo(root);
    const status = $('<div>', {class: 'personal-referrer-status', role: 'status', 'aria-live': 'polite'}).appendTo(root);
    const list = $('<ul>', {class: 'personal-referrer-results', 'aria-label': 'Найденные контакты'}).appendTo(root);
    const more = $('<button>', {type: 'button', text: 'Показать ещё', class: 'personal-referrer-more'}).hide().appendTo(root);
    const refresh = $('<button>', {type: 'button', text: 'Обновить', class: 'personal-referrer-refresh'}).appendTo(root);
    const s = {root, api: createReferrerApi(options => $.ajax(options)), dead: false, seq: 0,
      schema: null, card: null, record: null, busy: false, loading: true, query: '', page: 1, timer: null};
    state = s;
    const alive = () => !s.dead && (!s.card || s.card.current());
    const say = text => { if (alive()) status.text(text); };
    function nativeMatches(record) {
      const saved = core.savedId(record, s.schema.referrer.id);
      if (s.card.raw() !== (saved === null ? '' : String(saved))) return false;
      if (s.schema.channel) {
        const entry = (record.custom_fields_values || []).find(f => f.field_id === s.schema.channel.id);
        const val = entry && entry.values && entry.values[0];
        const stored = val && val.enum_id ? String(val.enum_id) : '';
        const live = s.card.raw(s.schema.channel.id);
        if ((live === '0' ? '' : live) !== stored) return false;
      }
      return true;
    }
    function enabled() {
      return alive() && s.record && s.schema && !s.busy && !s.loading &&
        core.eligible(s.record, s.schema) && nativeMatches(s.record);
    }
    function controls() {
      if (!alive()) return;
      let active = false;
      try { active = enabled(); } catch (error) { say(core.errorMessage(error)); }
      search.prop('disabled', !active);
      list.find('button').prop('disabled', !active);
      more.prop('disabled', !active);
      refresh.prop('disabled', s.busy || s.loading);
    }
    s.onChange = () => {
      if (s.syncing || !s.schema || !s.record || !alive()) return;
      s.seq++;
      clearTimeout(s.timer);
      list.empty(); more.hide();
      try {
        if (!nativeMatches(s.record)) say('Сохраните изменения полей карточки, затем нажмите «Обновить».');
      } catch (error) { say(core.errorMessage(error)); }
      controls();
    };
    function showContact(contact) {
      selected.empty().append($('<a>', {href: '/contacts/detail/' + core.id(contact.id), target: '_blank',
        rel: 'noopener noreferrer', text: contact.name || 'Контакт #' + contact.id}));
    }
    async function load() {
      if (s.busy || !alive()) return;
      const seq = ++s.seq;
      clearTimeout(s.timer);
      s.loading = true;
      search.prop('disabled', true); refresh.prop('disabled', true);
      list.empty(); more.hide(); selected.empty(); say('Загрузка…');
      try {
        if (!s.schema) s.schema = core.resolve(await s.api.fields(), self.get_settings());
        if (!alive() || seq !== s.seq) return;
        if (!s.card) {
          s.card = createReferrerCard($, app, s.schema.referrer.id);
          if (!core.id(s.card.id)) throw new Error('Сначала сохраните новую сделку, затем откройте её снова.');
          s.card.onChange(s.onChange);
        }
        const record = await s.api.request('GET', '/api/v4/leads/' + s.card.id);
        if (!alive() || seq !== s.seq) return;
        s.record = record;
        const contactId = core.savedId(record, s.schema.referrer.id);
        if (contactId) {
          try {
            const contact = await s.api.request('GET', '/api/v4/contacts/' + contactId);
            if (!alive() || seq !== s.seq) return;
            if (core.id(contact.id) !== contactId) throw new Error('Контакт не подтверждён.');
            showContact(contact);
          } catch (error) {
            if (!alive() || seq !== s.seq) return;
            selected.text('Contact ID ' + contactId + ': ' + core.errorMessage(error));
          }
        } else selected.text('Рекомендатель не выбран');
        if (!nativeMatches(record)) say('Сохраните изменения полей карточки, затем нажмите «Обновить».');
        else if (!core.eligible(record, s.schema)) say('Выбор доступен для канала «' + s.schema.referral.value + '».');
        else say('Выберите существующий контакт. Выбор сохраняется сразу.');
      } catch (error) { say(core.errorMessage(error)); }
      finally { s.loading = false; controls(); }
    }
    async function choose(contactId, seq) {
      try { if (seq !== s.seq || !enabled()) return; } catch (error) { say(core.errorMessage(error)); return; }
      seq = ++s.seq;
      clearTimeout(s.timer);
      s.busy = true; controls(); say('Проверка и сохранение…');
      let attempted = false;
      try {
        const fresh = await s.api.request('GET', '/api/v4/leads/' + s.card.id);
        if (!alive() || seq !== s.seq) throw new Error('Карточка изменилась. Обновите виджет.');
        if (!core.eligible(fresh, s.schema) || !nativeMatches(fresh)) {
          throw new Error('Канал или рекомендатель изменились. Обновите карточку перед выбором.');
        }
        const contact = await s.api.request('GET', '/api/v4/contacts/' + contactId);
        if (core.id(contact.id) !== contactId) throw new Error('Контакт не подтверждён.');
        if (!alive() || seq !== s.seq || !nativeMatches(fresh)) throw new Error('Карточка изменилась. Обновите виджет.');
        const previous = s.card.raw();
        if (core.savedId(fresh, s.schema.referrer.id) !== contactId) {
          // Recheck immediately before sending a queued mutation; no other lead fields are sent.
          await s.api.request('PATCH', '/api/v4/leads', core.payload(s.card.id, contactId, s.schema), () => {
            if (!alive() || seq !== s.seq || !nativeMatches(fresh)) return false;
            attempted = true;
            return true;
          });
        }
        const verified = await s.api.request('GET', '/api/v4/leads/' + s.card.id);
        if (core.savedId(verified, s.schema.referrer.id) !== contactId) throw new Error('Сохранение не подтверждено. Обновите карточку.');
        if (!alive()) return;
        s.syncing = true;
        let synced;
        try { synced = s.card.sync(previous, contactId); } finally { s.syncing = false; }
        s.record = verified;
        showContact(contact);
        list.empty(); more.hide(); search.val(''); ++s.seq;
        say(synced ? 'Рекомендатель сохранён.' : 'ID сохранён на сервере. Обновите карточку перед дальнейшим редактированием.');
      } catch (error) {
        say((attempted ? 'Результат записи требует проверки. Нажмите «Обновить». ' : '') + core.errorMessage(error));
      } finally { s.busy = false; controls(); }
    }
    async function find(query, page, seq) {
      if (!alive() || seq !== s.seq) return;
      more.hide(); say('Поиск…');
      try {
        const data = await s.api.request('GET', '/api/v4/contacts?query=' + encodeURIComponent(query) + '&limit=10&page=' + page,
          null, () => alive() && seq === s.seq);
        if (!alive() || seq !== s.seq) return;
        const contacts = (data._embedded || {}).contacts || [];
        if (page === 1) list.empty();
        for (const contact of contacts) {
          const contactId = core.id(contact.id);
          if (!contactId) continue;
          const row = $('<li>').appendTo(list);
          const button = $('<button>', {type: 'button', class: 'personal-referrer-option'}).appendTo(row);
          $('<strong>').text(contact.name || 'Контакт #' + contactId).appendTo(button);
          const details = $('<span>').text([core.phone(contact), 'ID ' + contactId].filter(Boolean).join(' · ')).appendTo(button);
          button.on('click.referrer', () => choose(contactId, seq));
          const company = ((contact._embedded || {}).companies || [])[0];
          if (company) {
            // Resolve sequentially, without an uncontrolled burst of requests per result page.
            const name = await s.api.companyName(company).catch(() => 'Компания недоступна');
            if (!alive() || seq !== s.seq) return;
            details.text([name, core.phone(contact), 'ID ' + contactId].filter(Boolean).join(' · '));
          }
        }
        s.page = page;
        more.toggle(!!(data._links || {}).next);
        say(contacts.length ? 'Выберите контакт из списка.' : page === 1 ? 'Контакты не найдены. Новый контакт не создаётся.' : 'Больше контактов нет.');
        controls();
      } catch (error) { if (alive() && seq === s.seq) say(core.errorMessage(error)); }
    }
    search.on('input.referrer', () => {
      const seq = ++s.seq;
      clearTimeout(s.timer); list.empty(); more.hide();
      const query = String(search.val()).trim(); s.query = query;
      if (Array.from(query).length < 2) { say('Введите минимум 2 символа.'); return; }
      s.timer = setTimeout(() => find(query, 1, seq), 450);
    }).on('keydown.referrer', event => {
      if (event.key === 'Escape') { ++s.seq; clearTimeout(s.timer); list.empty(); more.hide(); }
      if (event.key === 'Enter') event.preventDefault();
    });
    more.on('click.referrer', () => find(s.query, s.page + 1, s.seq));
    refresh.on('click.referrer', load);
    load();
    return true;
  }
  this.callbacks = {render: mount, init: () => true, bind_actions: () => true,
    settings: () => true, onSave: () => true, destroy};
  return this;
}
