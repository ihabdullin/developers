'use strict';
function createReferrerCore() {
  const ID_NAME = 'Рекомендовал – Contact ID';
  const CHANNEL_NAME = 'Канал привлечения';
  const normalize = value => String(value || '').trim().replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').toLowerCase();
  function id(value) {
    const text = String(value == null ? '' : value).trim();
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) return null;
    return Number(text);
  }
  function field(fields, name, configured, optional) {
    const matches = fields.filter(item => normalize(item.name) === normalize(name));
    if (configured) {
      const found = matches.find(item => item.id === id(configured));
      if (!found) throw new Error('Проверьте ID поля «' + name + '» в настройках виджета.');
      return found;
    }
    if (matches.length > 1) throw new Error('Несколько полей «' + name + '». Укажите нужный ID в настройках.');
    if (!matches.length && !optional) throw new Error('Нет поля «' + name + '». Настройте его по README; виджет поля не создаёт.');
    return matches[0] || null;
  }
  function resolve(fields, settings) {
    const referrer = field(fields, ID_NAME, settings.contact_id_field, false);
    if (!['numeric', 'text'].includes(referrer.type) || referrer.is_api_only) {
      throw new Error('Поле Contact ID должно быть доступным в карточке числом или текстом.');
    }
    const channel = field(fields, CHANNEL_NAME, settings.channel_field, true);
    let referral = null;
    if (channel) {
      if (channel.type !== 'select') throw new Error('Канал привлечения должен быть полем «Список».');
      const enums = channel.enums || [];
      const matches = settings.referral_enum
        ? enums.filter(item => item.id === id(settings.referral_enum))
        : enums.filter(item => ['рекомендация', 'рекомендации'].includes(normalize(item.value)));
      if (matches.length !== 1) throw new Error('Укажите ID значения рекомендации в настройках виджета.');
      referral = matches[0];
    }
    return {referrer, channel, referral};
  }
  function value(record, fieldId) {
    const found = (record.custom_fields_values || []).find(item => item.field_id === fieldId);
    return found && found.values && found.values[0] || null;
  }
  function savedId(record, fieldId) {
    const entry = value(record, fieldId);
    if (!entry || entry.value === '' || entry.value == null) return null;
    const parsed = id(entry.value);
    if (!parsed) throw new Error('В поле Contact ID записано некорректное значение. Исправьте его вручную.');
    return parsed;
  }
  function eligible(record, schema) {
    if (!schema.channel) return true;
    const entry = value(record, schema.channel.id);
    return !!entry && (id(entry.enum_id) === schema.referral.id ||
      (!entry.enum_id && entry.value === schema.referral.value));
  }
  function payload(leadId, contactId, schema) {
    if (!id(leadId) || !id(contactId)) throw new Error('Некорректный ID сделки или контакта.');
    return [{id: id(leadId), custom_fields_values: [{field_id: schema.referrer.id,
      values: [{value: schema.referrer.type === 'numeric' ? id(contactId) : String(id(contactId))}]}]}];
  }
  function phone(contact) {
    const field = (contact.custom_fields_values || []).find(item => item.field_code === 'PHONE');
    return field && field.values && field.values.map(item => String(item.value || '')).filter(Boolean).join(', ') || '';
  }
  function errorMessage(error) {
    if (error.status === 401) return 'Сессия истекла. Обновите страницу и войдите в amoCRM.';
    if (error.status === 403) return 'Недостаточно прав для этой операции.';
    if (error.status === 404) return 'Запись удалена или недоступна.';
    if (error.status === 429) return 'Лимит запросов. Подождите и повторите поиск.';
    if (error.status) return 'Ошибка API (' + error.status + '). Повторите чтение; запись автоматически не повторяется.';
    return error.message || 'Ошибка сети. Проверьте результат перед повторной записью.';
  }
  return {id, normalize, resolve, savedId, eligible, payload, phone, errorMessage};
}
if (typeof module === 'object' && module.exports) module.exports = createReferrerCore;
