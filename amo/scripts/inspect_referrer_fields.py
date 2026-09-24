"""Read-only inventory before installing the referrer widget. Never creates fields."""
import json
import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from amo import Client, configuration


def normalized(name):
    return re.sub(r'\s+', ' ', re.sub('[‐‑‒–—−]', '-', name.strip())).lower()


def main():
    fields = Client(configuration()).lead_fields()
    expected = ['Рекомендовал – Contact ID', 'Канал привлечения']
    result = {'total_fields': len(fields), 'fields': []}
    for name in expected:
        matches = [field for field in fields if normalized(field['name']) == normalized(name)]
        result['fields'].append({'name': name, 'status': 'missing' if not matches else 'unique' if len(matches) == 1 else 'ambiguous',
                                 'matches': [{key: f.get(key) for key in ('id', 'name', 'type', 'is_api_only', 'enums')} for f in matches]})
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
