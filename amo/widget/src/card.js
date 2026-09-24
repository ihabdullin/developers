'use strict';
// Keep the small native-form adapter separate: DOM names are not a stable API contract.
// Fail closed if amoCRM changes its field markup. Never guess a different input.
function createReferrerCard($, app, fieldId) {
  const card = app.data && app.data.current_card;
  if (!card || !card.model) throw new Error('Откройте сохранённую карточку сделки.');
  const leadId = Number(card.id);
  function current() { return app.data && app.data.current_card === card && Number(card.id) === leadId; }
  function input(selectedFieldId, writable) {
    selectedFieldId = selectedFieldId || fieldId;
    const prefix = 'CFV[' + selectedFieldId + ']';
    const matches = $('input').filter(function () {
      const name = this.getAttribute('name') || '';
      return name === prefix || name === prefix + '[VALUE]' ||
        new RegExp('^CFV\\[' + selectedFieldId + '\\]\\[\\d+\\]\\[VALUE\\]$').test(name);
    });
    if (matches.length !== 1 || (writable && (matches.prop('disabled') || matches.prop('readOnly')))) {
      throw new Error('Поле Contact ID недоступно для редактирования в карточке. Откройте вкладку с этим полем и нажмите «Обновить».');
    }
    return matches;
  }
  return {
    id: leadId, current,
    raw(selectedFieldId) { return String(input(selectedFieldId, !selectedFieldId).val() || '').trim(); },
    sync(expected, value) {
      if (!current()) return false;
      const target = input(null, true);
      if (String(target.val() || '').trim() !== expected) return false;
      target.val(String(value)).trigger('input').trigger('change');
      return String(target.val() || '').trim() === String(value);
    },
    onChange(handler) { card.model.on('change', handler); },
    offChange(handler) { card.model.off('change', handler); }
  };
}
if (typeof module === 'object' && module.exports) module.exports = createReferrerCard;
