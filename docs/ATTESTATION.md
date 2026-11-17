# Passport Attestation: DSSE + in-toto + Ed25519

> С версии schema 15 каждый запечатанный паспорт подписывается локальным
> Ed25519-ключом и упаковывается в DSSE-envelope с in-toto Statement внутри.
> Проверить подпись можно **без плагина, без базы и без сети** — публичный ключ
> едет внутри конверта.

---

## 1. Зачем

До schema 15 паспорт был **tamper-evident только относительно своей БД**:
`hash` + `prevHash` показывали, что запись не менялась, но не отвечали на вопрос
«кто и когда это выпустил». Для аудита, CI и второго человека этого мало.

Подпись добавляет ровно три свойства:

1. **Авторство.** Подпись принадлежит конкретному ключу; `keyid` — SHA-256 от
   публичного ключа.
2. **Целостность.** Любое изменение `intent`, файлов, checks, findings или
   вердикта ломает подпись.
3. **Переносимость.** Envelope самодостаточен: получателю не нужны ни наша БД,
   ни наш плагин.

Чего подпись **не** даёт: доверия к личности владельца ключа (это self-signed
identity), защиты от компрометации машины и порядка событий (нет transparency
log). Это описано в §6.

---

## 2. Формат

```
in-toto Statement
      │  canonical JSON (sorted keys)
      ▼
DSSE payload (base64)
      │  PAE(payloadType, payload)
      ▼
Ed25519 signature
      │
      ▼
DSSE envelope (JSON)
```

### 2.1. in-toto Statement

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    { "name": "src/passport.ts", "digest": { "sha256": "…" } },
    { "name": "git+code-shadow-master", "digest": { "gitCommit": "…" } }
  ],
  "predicateType": "https://code-shadow.dev/attestation/change-passport/v1",
  "predicate": {
    "passportId": "…",
    "intent": "…",
    "status": "sealed",
    "riskScore": 2,
    "riskLevel": "low",
    "checks": [ … ],
    "findings": [ … ],
    "evidenceIds": [ … ],
    "passportHash": "…",
    "prevHash": "…",
    "generator": "opencode-code-shadow",
    "generatorVersion": 1
  }
}
```

- `subject` — только файлы с известным SHA-256 (untracked-файлы без хеша не
  попадают). Пути **относительно корня проекта**, чтобы аттестация не зависела
  от `D:/…` на машине автора.
- `predicate` — вердикт паспорта. `reviewMd` намеренно не включён: это
  производный человекочитаемый артефакт, его можно пересобрать из predicate.
- `gitCommit` добавляется, если при запечатывании был доступен git.

### 2.2. DSSE envelope

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "<base64(statement JSON)>",
  "signatures": [
    {
      "keyid": "8f3c…",
      "sig": "<base64(Ed25519 signature over PAE)>",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n…"
    }
  ],
  "x-code-shadow-public-key": "-----BEGIN PUBLIC KEY-----\n…",
  "x-code-shadow-signed-at": 1794904929750
}
```

PAE (Pre-Authentication Encoding) — как в спецификации DSSE:

```
"DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
```

`LEN` — длина в байтах UTF-8, в ASCII-десятичном виде.

Поля `x-code-shadow-*` — расширение. Строгие DSSE-потребители их игнорируют;
публичный ключ продублирован в `signatures[0].publicKey`, чтобы конверт
проверялся автономно.

---

## 3. Ключи

| Что | Где |
|---|---|
| Приватный ключ (PKCS#8 PEM) | `~/.config/opencode/shadow/keys/passport-signing-key.pem` |
| Публичный ключ (SPKI PEM) | `…/passport-signing-key.pub.pem` |
| Явный путь | `signingKeyPath` в конфиге |
| Переменная окружения | `CODE_SHADOW_SIGNING_KEY=/path/to/key.pem` |

- Ключ генерируется лениво при первом `seal`/`attest`, режим файла `0600`
  (на Windows — best effort).
- Каталог по умолчанию вычисляется от `dbPath`: `<dir(dbPath)>/keys`. Поэтому
  тесты и временные БД не трогают боевой ключ.
- Ротация: удалить каталог ключей → следующий `seal` создаст новый. Старые
  паспорта останутся проверяемыми, потому что публичный ключ хранится в каждом
  конверте.

---

## 4. Политика

```jsonc
{
  "passportSignaturePolicy": "require" // require (default) | warn | off
}
```

| Политика | Нет ключа | Подпись не прошла |
|---|---|---|
| `require` (default) | `passport-signed: fail` → `status=blocked` | `fail` → `blocked` |
| `warn` | `passport-signed: warn` → `sealed` | `fail` → `blocked` |
| `off` | подпись не создаётся, check отсутствует | — |

`off` нужен для окружений, где нельзя писать ключ (read-only ФС, эфемерный CI).
По умолчанию — `require`: неподписанный паспорт не считается доказательством.

---

## 5. Проверка

### 5.1. Из плагина

```text
code_shadow_passport action="verify" passport_id="…"
```

Возвращает:

```json
{
  "status": "valid | stale | tampered | unsigned",
  "hash_valid": true,
  "files_valid": true,
  "evidence_valid": true,
  "problems": [],
  "signature": {
    "present": true,
    "valid": true,
    "key_id": "8f3c…",
    "signed_at": 1794904929750,
    "statement_digest": "…",
    "statement_digest_matches": true,
    "subject_count": 26,
    "error": null
  }
}
```

- `tampered` — подпись или hash паспорта не сходятся.
- `unsigned` — политика требует подпись, а её нет.
- `stale` — подпись валидна, но файлы на диске изменились после seal.
- `valid` — всё сходится.

### 5.2. Без плагина

```bash
# экспорт: .md, .json, .att.json (DSSE), .intoto.jsonl (bundle)
code_shadow_passport action="export" passport_id="…"

node scripts/verify-passport.js ~/.config/opencode/shadow/passports/<id>.att.json
node scripts/verify-passport.js <id>.intoto.jsonl --json
```

Скрипт использует только `node:crypto`: без зависимостей, без БД, без сети.
Коды выхода: `0` — подпись валидна, `1` — невалидна, `2` — ошибка чтения.

### 5.3. Пример вывода

```text
VALID
  key:       8f3c2a91d4e7b6c05a1f…
  signed:    2026-11-17T08:42:09.750Z
  predicate: https://code-shadow.dev/attestation/change-passport/v1
  passport:  3b6668c4-… (sealed, risk 2/100 (low))
  subjects:  26
    - src/observer.ts (sha256:782f107be6a1)
    - …
```

---

## 6. Модель угроз и ограничения

**Что подпись закрывает**

- Подмену `intent`, файлов, checks, findings, risk или вердикта после seal.
- Подмену самого паспорта в БД без доступа к приватному ключу.
- «Доказательство», которое нельзя проверить вне машины автора.

**Что не закрывает**

| Угроза | Почему | Что делать |
|---|---|---|
| Компрометация приватного ключа | Ключ локальный, без passphrase | Хранить вне репозитория, ротировать, в перспективе — OS keychain |
| Подмена личности | Нет CA, нет OIDC-bound identity | Sigstore/cosign с OIDC или корпоративный CA |
| Удаление/переупорядочивание паспортов | Нет transparency log | Публикация цепочки `prevHash` во внешний append-only лог |
| Агент врёт о фактах | Подпись подтверждает «этот агент так сказал», а не истинность | Независимые проверки: tests/typecheck/Semgrep как evidence |
| Подмена файлов до seal | Хеши считаются на момент seal | `baseRef`/diff-aware проверка + CI |

Формулировка, которую можно использовать честно: **«подписанное утверждение
агента о своём изменении, проверяемое без плагина»**, а не «доказательство
правильности кода».

---

## 7. Совместимость

- **DSSE** — формат совпадает; `node scripts/verify-passport.js` реализует
  проверку независимо.
- **in-toto** — Statement v1 и predicate type. Полноценный layout/verification
  policy не реализован.
- **Sigstore/cosign** — не обязателен. Envelope можно дополнительно подписать
  cosign (`cosign sign-blob`) в CI поверх файла `.att.json`.
- **SLSA** — паспорт не является build provenance. Это attestation об изменении
  кода, а не о сборке артефакта.

---

## 8. Схема БД

Миграция `015_attestation.ts` добавляет в `change_passports`:

| Колонка | Смысл |
|---|---|
| `attestation` | DSSE envelope целиком (JSON) |
| `key_id` | keyid подписи |
| `signature` | base64 Ed25519-подпись (денормализация для запросов) |
| `public_key` | SPKI PEM, которым подписан паспорт |
| `statement_digest` | SHA-256 canonical statement |
| `signed_at` | время подписи |

Денормализация нужна, чтобы TUI и SQL-отчёты видели статус подписи без разбора
JSON.
