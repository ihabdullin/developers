'use strict';
function createReferrerApi(ajax, wait) {
  const sleep = wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let tail = Promise.resolve();
  let stopped = false;
  const companies = new Map();
  function request(method, path, body, valid) {
    if (!/^\/api\/v4\/(contacts(?:\/[1-9]\d*)?|companies\/[1-9]\d*|leads(?:\/[1-9]\d*|\/custom_fields)?)(?:\?[^#]*)?$/.test(path) ||
        !['GET', 'PATCH'].includes(method) || (method === 'PATCH' && path !== '/api/v4/leads')) {
      return Promise.reject(new Error('Недопустимый запрос виджета.'));
    }
    const run = async () => {
      if (stopped || (valid && !valid())) throw new Error('Запрос отменён: карточка или выбор изменились.');
      let response;
      try {
        response = await ajax({url: path, method, dataType: 'json', timeout: 15000,
          ...(body ? {contentType: 'application/json', data: JSON.stringify(body)} : {})});
      } finally {
        // One sequential queue per widget instance, including failures. No blind write retries.
        await sleep(300);
      }
      return response || {};
    };
    const task = tail.then(run);
    tail = task.catch(() => {});
    return task;
  }
  async function fields() {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const data = await request('GET', '/api/v4/leads/custom_fields?page=' + page + '&limit=50');
      result.push(...((data._embedded || {}).custom_fields || []));
      if (!(data._links || {}).next) return result;
    }
    throw new Error('Список полей неполный. Настройка остановлена.');
  }
  async function companyName(company) {
    if (!company || !/^[1-9]\d*$/.test(String(company.id))) return '';
    if (company.name) return company.name;
    if (!companies.has(company.id)) {
      companies.set(company.id, request('GET', '/api/v4/companies/' + company.id)
        .then(data => data.name || '').catch(error => { companies.delete(company.id); throw error; }));
    }
    return companies.get(company.id);
  }
  return {request, fields, companyName, stop() { stopped = true; }};
}
if (typeof module === 'object' && module.exports) module.exports = createReferrerApi;
