#!/usr/bin/env python3
"""Local amoCRM v4 client with explicit single-record writes. Python 3.9+, standard library only."""
import argparse
import fcntl
import getpass
import json
import logging
import os
from pathlib import Path
import re
import sys
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger('amo')
RESOURCES = {'leads': 'leads', 'contacts': 'contacts', 'companies': 'companies',
             'tasks': 'tasks', 'pipelines': 'leads/pipelines'}

class AmoError(Exception):
    pass

class HTTPError(AmoError):
    def __init__(self, status, hint=None):
        self.status = status
        super().__init__('HTTP %s. %s Тело ответа скрыто.' %
                         (status, hint or 'Проверьте доступы/настройки.'))

def oauth_error_hint(raw):
    # Only fixed labels are returned; never echo server text or supplied credentials.
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(data, dict):
        return None
    fields = ' '.join(str(data.get(k, '')) for k in
                      ('error', 'hint', 'detail', 'title', 'error_description')).lower()
    if 'redirect' in fields:
        return 'OAuth: проверьте точное совпадение Redirect URI.'
    if 'invalid_client' in fields or 'client authentication failed' in fields:
        return 'OAuth: сервер отклонил ID или секрет интеграции.'
    if 'expired' in fields:
        return 'OAuth: сервер сообщает об истёкших авторизационных данных; нужен свежий код.'
    if 'invalid_grant' in fields or 'authorization code' in fields:
        return 'OAuth: код/refresh token отклонён; возможны истечение, повторное использование или несовпадение интеграции.'
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def private_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def validate(config):
    if not re.fullmatch(r'https://[a-zA-Z0-9-]+\.amocrm\.ru', config.get('AMO_BASE_URL', '')):
        raise AmoError('Нужен адрес личного аккаунта https://имя.amocrm.ru без пути.')
    for key in ('AMO_CLIENT_ID', 'AMO_CLIENT_SECRET', 'AMO_REDIRECT_URI'):
        if not config.get(key):
            raise AmoError('Не заполнено ' + key + '. Выполните setup.')
    return config

def configuration():
    path = ROOT / '.env'
    if not path.exists():
        raise AmoError('Сначала выполните python3 amo.py setup.')
    if path.stat().st_mode & 0o077:
        raise AmoError('Ограничьте доступ: chmod 600 .env')
    config = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith('#'):
            key, value = line.split('=', 1)
            config[key] = value
    return validate(config)

class Client:
    def __init__(self, config, directory=None, allow_writes=False):
        self.allow_writes = allow_writes
        self.config = validate(config)
        self.directory = directory or ROOT / '.private'
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        self.token_path = self.directory / 'tokens.json'
        # No environment proxies or cross-host redirects carrying credentials.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    @contextmanager
    def locked(self):
        fd = os.open(str(self.directory / 'oauth.lock'), os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def transport(self, method, path, payload=None, token=None):
        allowed_get = re.fullmatch(r'/api/v4/((leads|contacts|companies|tasks)(/[0-9]+)?|leads/pipelines|leads/pipelines/[0-9]+/statuses)(\?page=[0-9]+&limit=[0-9]+)?', path)
        allowed_write = (self.allow_writes and method in ('POST', 'PATCH') and
                         re.fullmatch(r'/api/v4/(leads|contacts|companies|tasks)', path))
        if allowed_write:
            if not isinstance(payload, list) or len(payload) != 1:
                raise AmoError('Разрешена запись только одной сущности за запрос.')
            validate_record(path.rsplit('/', 1)[-1], payload[0], method == 'PATCH')
        if not (allowed_write or (method == 'GET' and allowed_get and payload is None) or
                (method == 'POST' and path == '/oauth2/access_token')):
            raise AmoError('Запрос заблокирован политикой read-only.')
        headers = {'Accept': 'application/json', 'User-Agent': 'personal-amo-local/0.2'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        data = None
        if payload is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(payload).encode()
        request = urllib.request.Request(self.config['AMO_BASE_URL'] + path,
                                         data=data, headers=headers, method=method)
        for attempt in range(3):
            try:
                with self.opener.open(request, timeout=30) as response:
                    LOG.info('%s %s status=%s', method, path.split('?')[0], response.status)
                    raw = response.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as error:
                status = error.code
                hint = None
                try:
                    if path == '/oauth2/access_token':
                        hint = oauth_error_hint(error.read(16384))
                finally:
                    error.close()
                LOG.warning('%s %s status=%s', method, path.split('?')[0], status)
                if method == 'GET' and (status == 429 or status in (502, 503, 504)) and attempt < 2:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise HTTPError(status, hint) from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise AmoError('Ошибка сети/TLS. Запись/OAuth не повторяется автоматически. При записи результат неизвестен: проверьте CRM перед повтором.') from None

    def read_tokens(self):
        if not self.token_path.exists():
            raise AmoError('Нет токенов. Выполните auth.')
        data = json.loads(self.token_path.read_text())
        if data.get('account') != self.config['AMO_BASE_URL'] or data.get('client_id') != self.config['AMO_CLIENT_ID']:
            raise AmoError('Токены принадлежат другой конфигурации. Выполните auth.')
        return data

    def exchange(self, grant, value):
        payload = {'client_id': self.config['AMO_CLIENT_ID'],
                   'client_secret': self.config['AMO_CLIENT_SECRET'],
                   'redirect_uri': self.config['AMO_REDIRECT_URI'], 'grant_type': grant,
                   'code' if grant == 'authorization_code' else 'refresh_token': value}
        started = time.time()
        data = self.transport('POST', '/oauth2/access_token', payload)
        if not all(data.get(key) for key in ('access_token', 'refresh_token', 'expires_in')):
            raise AmoError('Некорректный ответ OAuth; значения скрыты.')
        saved = {key: data[key] for key in ('access_token', 'refresh_token')}
        saved.update(expires_at=started + int(data['expires_in']),
                     account=self.config['AMO_BASE_URL'], client_id=self.config['AMO_CLIENT_ID'])
        private_write(self.token_path, json.dumps(saved))
        LOG.info('OAuth: новая пара токенов сохранена')
        return saved['access_token']

    def authorize(self, code):
        with self.locked():
            self.exchange('authorization_code', code)

    def access_token(self, rejected=None, force=False):
        with self.locked():
            data = self.read_tokens()
            if force or data['expires_at'] <= time.time() + 60 or rejected == data['access_token']:
                return self.exchange('refresh_token', data['refresh_token'])
            return data['access_token']

    def get(self, path):
        token = self.access_token()
        try:
            return self.transport('GET', path, token=token)
        except HTTPError as error:
            if error.status != 401:
                raise
        token = self.access_token(rejected=token)
        return self.transport('GET', path, token=token)

    def write(self, resource, fields, entity_id=None):
        if not self.allow_writes:
            raise AmoError('Запись не включена для этого клиента.')
        record = dict(fields)
        if 'id' in record:
            raise AmoError('Передайте ID отдельно, а не в полях.')
        if entity_id is not None:
            record['id'] = entity_id
        validate_record(resource, record, entity_id is not None)
        method = 'PATCH' if entity_id is not None else 'POST'
        path = '/api/v4/' + resource
        token = self.access_token()
        try:
            response = self.transport(method, path, [record], token=token)
        except HTTPError as error:
            if error.status != 401:
                raise
            token = self.access_token(rejected=token)
            response = self.transport(method, path, [record], token=token)
        records = response.get('_embedded', {}).get(resource, [])
        if len(records) != 1 or not isinstance(records[0].get('id'), int):
            raise AmoError('Ответ записи не содержит ID. Проверьте CRM перед повтором.')
        LOG.info('CRM write completed resource=%s id=%s', resource, records[0]['id'])
        return records[0]

    def listing(self, resource, pages=1, pipeline=None):
        if resource == 'statuses':
            if not isinstance(pipeline, int) or pipeline <= 0:
                raise AmoError('Нужен положительный --pipeline ID.')
            path = 'leads/pipelines/%s/statuses' % pipeline
        else:
            path = RESOURCES[resource]
        items = []
        for page in range(1, pages + 1):
            suffix = '?page=%s&limit=50' % page if resource in ('leads', 'contacts', 'companies', 'tasks') else ''
            data = self.get('/api/v4/' + path + suffix)
            items.extend(data.get('_embedded', {}).get(resource, []))
            if not suffix or not data.get('_links', {}).get('next'):
                break
            time.sleep(0.2)
        return items

WRITE_FIELDS = {
    'leads': {'name', 'price', 'pipeline_id', 'status_id', 'responsible_user_id', 'custom_fields_values'},
    'contacts': {'name', 'first_name', 'last_name', 'responsible_user_id', 'custom_fields_values'},
    'companies': {'name', 'responsible_user_id', 'custom_fields_values'},
    'tasks': {'text', 'complete_till', 'task_type_id', 'responsible_user_id',
              'entity_id', 'entity_type', 'is_completed', 'result', 'duration'},
}


def validate_record(resource, record, update=False):
    if resource not in WRITE_FIELDS or not isinstance(record, dict) or not record:
        raise AmoError('Нужна одна сущность leads/contacts/companies/tasks в виде JSON-объекта.')
    allowed = WRITE_FIELDS[resource] | ({'id'} if update else set())
    if set(record) - allowed:
        raise AmoError('В JSON есть неподдерживаемые поля.')
    if update and (type(record.get('id')) is not int or record['id'] <= 0 or len(record) == 1):
        raise AmoError('Для изменения нужны положительный ID и хотя бы одно поле.')
    if not update:
        required = {'text', 'complete_till'} if resource == 'tasks' else {'name'}
        if not required <= set(record):
            raise AmoError('Для создания нужны name либо text и complete_till для задачи.')
    for key, value in record.items():
        if key in {'id', 'pipeline_id', 'status_id', 'responsible_user_id', 'entity_id', 'task_type_id', 'complete_till'}:
            if type(value) is not int or value <= 0:
                raise AmoError('ID и время должны быть положительными целыми числами.')
        if key in {'price', 'duration'} and (type(value) is not int or value < 0):
            raise AmoError('Сумма/длительность должна быть неотрицательным целым числом.')
        if key in {'name', 'first_name', 'last_name', 'text'} and (not isinstance(value, str) or not value.strip()):
            raise AmoError('Текстовое поле должно быть непустой строкой.')
        if key == 'entity_type' and value not in ('leads', 'contacts', 'companies'):
            raise AmoError('Неподдерживаемый тип связанной сущности.')
        if key == 'is_completed' and type(value) is not bool:
            raise AmoError('is_completed должен быть boolean.')
        if key == 'result' and (not isinstance(value, dict) or set(value) != {'text'} or not isinstance(value['text'], str)):
            raise AmoError('Результат задачи должен содержать только text.')
        if key == 'custom_fields_values' and not isinstance(value, list):
            raise AmoError('custom_fields_values должен быть массивом API v4.')
    if ('entity_id' in record) != ('entity_type' in record):
        raise AmoError('entity_id и entity_type передаются вместе.')


def setup():
    if (ROOT / '.env').exists():
        raise AmoError('.env уже существует. Измените его локально при необходимости.')
    config = {'AMO_BASE_URL': (input('Адрес личного amoCRM [https://infomedaccountru.amocrm.ru]: ').strip() or 'https://infomedaccountru.amocrm.ru').rstrip('/'),
              'AMO_CLIENT_ID': input('ID интеграции: ').strip(),
              'AMO_CLIENT_SECRET': getpass.getpass('Секрет интеграции (скрыт): ').strip(),
              'AMO_REDIRECT_URI': input('Redirect URI [http://localhost:8765/callback]: ').strip() or 'http://localhost:8765/callback'}
    validate(config)
    if any('\n' in value or '\r' in value for value in config.values()):
        raise AmoError('Переносы строк недопустимы.')
    private_write(ROOT / '.env', ''.join('%s=%s\n' % item for item in config.items()))
    print('Настройки сохранены локально, права 600.')

def clipboard_code():
    try:
        result = subprocess.run(['/usr/bin/pbpaste'], capture_output=True, timeout=5, check=True)
        code = result.stdout.decode('utf-8').strip()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise AmoError('Не удалось прочитать буфер обмена Mac.') from None
    if not code or any(char.isspace() for char in code):
        raise AmoError('В буфере нет цельного кода. Скопируйте только код авторизации из amoCRM.')
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['setup', 'auth', 'refresh', 'check', 'create', 'update'] + list(RESOURCES) + ['statuses'])
    parser.add_argument('--pages', type=int, default=1, help='Максимум страниц, по 50 записей')
    parser.add_argument('--pipeline', type=int)
    parser.add_argument('--json', action='store_true', help='Вывести данные CRM в stdout (не в журнал)')
    parser.add_argument('--from-clipboard', action='store_true', help='Для auth: прочитать код из буфера Mac без вывода')
    parser.add_argument('--resource', choices=list(WRITE_FIELDS))
    parser.add_argument('--id', type=int, help='ID изменяемой сущности')
    parser.add_argument('--data-file', type=Path, help='Локальный JSON с полями одной сущности')
    parser.add_argument('--apply', action='store_true', help='Выполнить запись; без флага только просмотр')
    args = parser.parse_args()
    if args.from_clipboard and args.command != 'auth':
        parser.error('--from-clipboard доступен только для auth')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try:
        if args.pages < 1 or args.pages > 100:
            raise AmoError('--pages: от 1 до 100')
        if args.command == 'setup':
            setup()
            return
        if args.command in ('create', 'update'):
            if not args.resource or not args.data_file:
                raise AmoError('Укажите --resource и --data-file.')
            fields = json.loads(args.data_file.read_text())
            if not isinstance(fields, dict) or 'id' in fields:
                raise AmoError('Нужен JSON-объект без id. Для изменения используйте --id.')
            if args.command == 'update' and args.id is None:
                raise AmoError('Для update нужен --id.')
            if args.command == 'create' and args.id is not None:
                raise AmoError('Для create нельзя указывать --id.')
            record = dict(fields)
            if args.id is not None:
                record['id'] = args.id
            validate_record(args.resource, record, args.command == 'update')
            if not args.apply:
                print(json.dumps({'preview': True, 'operation': args.command,
                                  'resource': args.resource, 'record': record}, ensure_ascii=False, indent=2))
                return
            client = Client(configuration(), allow_writes=True)
            result = client.write(args.resource, fields, args.id)
            print(json.dumps({'resource': args.resource, 'id': result['id']}, ensure_ascii=False))
            return
        client = Client(configuration())
        if args.command == 'auth':
            code = clipboard_code() if args.from_clipboard else getpass.getpass('Код авторизации из вкладки «Ключи» (скрыт): ').strip()
            if not code:
                raise AmoError('Код авторизации пуст.')
            client.authorize(code)
        elif args.command == 'refresh':
            client.access_token(force=True)
        elif args.command == 'check':
            for resource in RESOURCES:
                items = client.listing(resource)
                print('%s: OK, прочитано %s (первая страница)' % (resource, len(items)))
                if resource == 'pipelines':
                    for pipeline in items:
                        statuses = client.listing('statuses', pipeline=pipeline['id'])
                        print('statuses pipeline=%s: OK, %s' % (pipeline['id'], len(statuses)))
                        time.sleep(0.2)
                time.sleep(0.2)
        else:
            items = client.listing(args.command, args.pages, args.pipeline)
            if args.json:
                print(json.dumps(items, ensure_ascii=False, indent=2))
            else:
                print('Прочитано: %s' % len(items))
                for item in items:
                    print(json.dumps({key: item[key] for key in ('id', 'name', 'price', 'status_id', 'pipeline_id') if key in item}, ensure_ascii=False))
    except (AmoError, ValueError, KeyError, OSError):
        error = sys.exc_info()[1]
        LOG.error('%s', str(error) if isinstance(error, AmoError) else 'Ошибка конфигурации/файла/формата; содержимое скрыто.')
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        sys.exit(130)

if __name__ == '__main__':
    main()
