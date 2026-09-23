"""One-time authorized live test; persist ID, never blindly repeat a create."""
import json
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from amo import Client, configuration, private_write, ROOT

client = Client(configuration(), allow_writes=True)
receipt = ROOT / '.private' / 'write-test.json'
if receipt.exists():
    raise SystemExit('Test receipt already exists; inspect it before another run.')
pipelines = client.listing('pipelines')
pipeline = next(p for p in pipelines if p.get('is_main') and not p.get('is_archive'))
name = '[ТЕСТ API MAC] Проверка интеграции ' + time.strftime('%Y-%m-%d %H:%M:%S')
private_write(receipt, json.dumps({'state': 'pending', 'name': name}, ensure_ascii=False))
created = client.write('leads', {'name': name, 'price': 0, 'pipeline_id': pipeline['id'], 'status_id': 143})
entity_id = created['id']
private_write(receipt, json.dumps({'state': 'created', 'id': entity_id}, ensure_ascii=False))
first = client.get('/api/v4/leads/%s' % entity_id)
assert first['name'] == name and first['price'] == 0 and first['status_id'] == 143
updated_name = name + ' — создание и изменение проверены'
client.write('leads', {'name': updated_name}, entity_id)
last = client.get('/api/v4/leads/%s' % entity_id)
assert last['name'] == updated_name and last['price'] == 0 and last['status_id'] == 143
private_write(receipt, json.dumps({'state': 'verified', 'id': entity_id, 'status_id': 143, 'checked_at': time.strftime('%Y-%m-%d %H:%M:%S')}, ensure_ascii=False))
print(json.dumps({'verified': True, 'id': entity_id, 'status_id': 143, 'url': client.config['AMO_BASE_URL'] + '/leads/detail/' + str(entity_id)}))
