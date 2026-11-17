# AUDIT D3/D4 — шум guardrails и «дубли» `session_completed`

**Дата:** 2026-11-14  
**Роль:** исполнитель C (read-only аудит)  
**Репозиторий:** `<repo>`, HEAD `ec26513`  
**БД:** `%USERPROFILE%\.config\opencode\shadow\data.db` — только чтение  
**Изменения:** C не менял код и не писал в БД; телеметрия плагина продолжала расти (срез на 10:54:59 MSK 14.11.2026: события 3906–3910; позднее появился 3911).

---

## 1. Контекст

Проверяются два дефекта телеметрии Code Shadow:

- **D3.** В `developer_events` — 838 событий `tool_rejected`; топ проектов: `launcher_src` 230, `C:\mods\1122` 130, `forge_1.12.2_full_src` 85. Нужно понять, это реальные циклы агента или ложные срабатывания failure-loop guard.
- **D4.** 1903 события `session_completed` на 300 сессий, максимум 124 на одну сессию. Нужно понять, это исторические данные до фикса 12.11.2026 или проблема продолжается.

Фикс, на который ссылается задача:

- коммит `8475313` — `feat: harden agent guardrails, project scope and memory search (#1)`, **2026-11-12 18:59:25 +03:00**;
- `docs/FIX_PLAN.md:40` прямо перечисляет: «`session.idle` считает counts до flush, повторный idle дублирует события»;
- `docs/FIX_PLAN.md:63` — observer state стал per-instance, `toolLoopMap` получил TTL/cap.

В рабочем дереве на момент аудита были незакоммиченные изменения (включая `src/index.ts`), но `src/observer.ts` и `src/storage.ts` соответствуют HEAD; аудит кода ниже — по ним. На момент аудита pre-existing untracked-файлов было три, C их не создавал: `src/v2.ts`, `src/tui-v2.ts`, `tests/v2-events.test.ts`. Актуальное состояние на 14.11.2026 — четыре: к ним добавился `tests/tui-v2.test.ts` (создан 10:55:38 другой сессией). Единственный файл C в репозитории — этот отчёт; audit-скрипты остались в `%TEMP%\opencode\audit_*.py`.

---

## 2. Метод (SQL)

Подключение строго read-only:

```python
sqlite3.connect("file:%USERPROFILE%/.config/opencode/shadow/data.db?mode=ro", uri=True)
```

Версия SQLite — 3.45.1. Все запросы ниже — `SELECT`/`PRAGMA`; запись не выполнялась. Пути замаскированы частично: `%USERPROFILE%` — домашний каталог пользователя, `<repo>` — репозиторий, `<work>` — прочие пользовательские каталоги. Рабочие каталоги проектов (`C:\mods\1122`, `C:\forge\...`, `D:\321\nvidia`) оставлены абсолютными — username они не раскрывают.

### 2.1. Единицы времени и границы

`developer_events.timestamp` — **миллисекунды Unix epoch, UTC**. Проверено преобразованием min/max:

```
min = 1790703289560 -> 2026-09-29 17:34:49 UTC
max = 1794641453641 -> 2026-11-14 07:30:53 UTC
```

Локальная зона машины/коммитов — MSK (UTC+3). Поэтому:

| Граница | MSK | UTC | ms |
|---|---|---|---|
| Полночь 12.11.2026 | 2026-11-12 00:00:00 | 2026-11-11 21:00:00 | `1794430800000` |
| Коммит-фикс `8475313` | 2026-11-12 18:59:25 | 2026-11-12 15:59:25 | `1794499165000` |

Дополнительно: `dist/observer.js` собран **12.11.2026 18:51**, уже содержит dedupe. Последняя пара `session_completed` в одну секунду — **12.11.2026 17:30:44 MSK**, то есть до и сборки, и коммита. Любая граница после 17:30 даёт одинаковый вывод по D4.

### 2.2. Снимок данных

БД живёт: плагин продолжает писать в неё во время аудита. Чтобы цифры были воспроизводимы, все таблицы D3/D4 ниже посчитаны на снимке:

```
developer_events WHERE id <= 3905
```

Это 3905 событий, `max(id)=3905`, `max(timestamp)=2026-11-14 07:30:53 UTC`. В SQL раздела 2 фильтр `id <= 3905` для читаемости опущен; в проверочном приложении 8 он указан явно.

После снимка, пока готовился отчёт, появились события `id=3906..3910` (три новых warning и два `session_started`, см. 3.9). Они не входят в таблицы, но важны как живое воспроизведение D3.

### 2.3. Основные запросы

**Q1. Типы событий и диапазон.**

```sql
SELECT event_type,
       COUNT(*) AS c,
       COUNT(DISTINCT session_id) AS sessions,
       MIN(timestamp) AS mn,
       MAX(timestamp) AS mx
FROM developer_events
GROUP BY event_type
ORDER BY c DESC;
```

**Q2. Разрез до/после 12.11.**

```sql
SELECT event_type,
       SUM(timestamp <  :cut) AS before,
       SUM(timestamp >= :cut) AS after
FROM developer_events
GROUP BY event_type
ORDER BY before + after DESC;
```

**Q3. Причины `tool_rejected`.**

```sql
SELECT json_extract(metadata, '$.reason') AS reason,
       COUNT(*) AS c,
       SUM(timestamp <  :cut) AS before,
       SUM(timestamp >= :cut) AS after,
       COUNT(DISTINCT session_id) AS sessions,
       COUNT(DISTINCT file_path) AS files
FROM developer_events
WHERE event_type = 'tool_rejected'
GROUP BY reason
ORDER BY c DESC;
```

**Q4. Проекты и инструменты `tool_rejected`.**

```sql
SELECT s.project_root,
       COUNT(*) AS c,
       SUM(json_extract(e.metadata,'$.reason') = 'successful_edit_loop_warning') AS warn,
       SUM(json_extract(e.metadata,'$.reason') = 'successful_edit_loop_blocked') AS blocked,
       SUM(json_extract(e.metadata,'$.reason') = 'change_contract_preflight') AS preflight,
       SUM(json_extract(e.metadata,'$.reason') = 'agent_loop_detected') AS loop
FROM developer_events e
LEFT JOIN sessions s ON s.id = e.session_id
WHERE e.event_type = 'tool_rejected'
GROUP BY s.project_root
ORDER BY c DESC;

SELECT json_extract(metadata,'$.reason') AS reason,
       json_extract(metadata,'$.tool') AS tool,
       COUNT(*) AS c
FROM developer_events
WHERE event_type = 'tool_rejected'
GROUP BY reason, tool
ORDER BY c DESC;
```

**Q5. Распределение `session_completed` по сессиям.**

```sql
WITH per_session AS (
  SELECT session_id, COUNT(*) AS c,
         MIN(timestamp) AS mn, MAX(timestamp) AS mx
  FROM developer_events
  WHERE event_type = 'session_completed'
  GROUP BY session_id
)
SELECT CASE
         WHEN c = 1 THEN '1'
         WHEN c BETWEEN 2 AND 5 THEN '2-5'
         WHEN c BETWEEN 6 AND 20 THEN '6-20'
         WHEN c BETWEEN 21 AND 50 THEN '21-50'
         WHEN c BETWEEN 51 AND 100 THEN '51-100'
         ELSE '100+'
       END AS bucket,
       COUNT(*) AS sessions,
       SUM(c) AS events
FROM per_session
GROUP BY bucket
ORDER BY MIN(c);
```

**Q6. Интервалы между соседними `session_completed` одной сессии.**

```sql
WITH e AS (
  SELECT session_id, timestamp,
         LAG(timestamp) OVER (PARTITION BY session_id ORDER BY timestamp) AS prev
  FROM developer_events
  WHERE event_type = 'session_completed'
)
SELECT
  SUM(CASE WHEN timestamp / 1000 = prev / 1000 THEN 1 ELSE 0 END) AS same_second_pairs,
  SUM(CASE WHEN timestamp - prev < 1000 THEN 1 ELSE 0 END)     AS lt_1s_pairs,
  SUM(CASE WHEN timestamp - prev < 60000 THEN 1 ELSE 0 END)    AS lt_60s_pairs,
  COUNT(*)                                                      AS pairs
FROM e
WHERE prev IS NOT NULL;
```

**Q7. Была ли активность между двумя `session_completed`.**

Для каждой пары событий одной сессии:

```sql
SELECT COUNT(*)
FROM tool_executions
WHERE session_id = :sid
  AND timestamp > :prev_ts
  AND timestamp <= :curr_ts;
```

Аналогично проверялись `file_edits` и события `human_fix`/`command_used`/`session_started`. Пара считалась «активной», если между событиями был хотя бы один tool execution, file edit или одно из перечисленных developer-событий.

**Q8. Сверка с `sessions`.**

```sql
SELECT s.id, s.status, s.ended_at, s.duration_ms, s.started_at,
       (SELECT COUNT(*) FROM developer_events e
         WHERE e.session_id = s.id AND e.event_type = 'session_completed') AS c,
       (SELECT MAX(timestamp) FROM developer_events e
         WHERE e.session_id = s.id AND e.event_type = 'session_completed') AS last_ts
FROM sessions s
WHERE c > 1
ORDER BY c DESC;
```

---

## 3. Наблюдения (таблицы)

### 3.1. Q1 — общая картина

| event_type | событий | сессий | первое (UTC) | последнее (UTC) |
|---|---:|---:|---|---|
| `session_completed` | 1903 | 300 | 2026-09-29 17:35:05 | 2026-11-14 07:30:53 |
| `tool_rejected` | 838 | 82 | 2026-09-29 20:27:26 | 2026-11-14 07:26:27 |
| `human_fix` | 835 | 31 | 2026-11-12 15:25:55 | 2026-11-14 07:28:52 |
| `session_started` | 319 | 318 | 2026-09-29 17:34:49 | 2026-11-14 07:07:24 |
| `command_used` | 8 | 8 | 2026-09-29 17:39:19 | 2026-11-12 13:21:36 |
| `session_end` | 2 | 2 | 2026-11-12 20:37:08 | 2026-11-13 21:56:02 |

На снимке — 3905 событий; `session_completed` и `tool_rejected` дают 70% таблицы.

### 3.2. Q2 — разрез до/после 12.11

**Граница — полночь 12.11.2026 (MSK):**

| event_type | до 00:00 | после 00:00 |
|---|---:|---:|
| `session_completed` | 1507 | 396 |
| `tool_rejected` | 502 | 336 |
| `human_fix` | 0 | 835 |
| `session_started` | 190 | 129 |
| `command_used` | 4 | 4 |
| `session_end` | 0 | 2 |

**Граница — коммит-фикс 12.11.2026 18:59 MSK:**

| event_type | до фикса | после фикса |
|---|---:|---:|
| `session_completed` | 1612 | **291** (99 сессий) |
| `tool_rejected` | 618 | **220** |
| `session_started` | 220 | 99 |

То есть «после 12.11» — это не 396 дублей: 105 из них попали в окно 00:00–18:59, а 291 — уже после фикса.

### 3.3. Q3 — из чего состоит `tool_rejected`

| reason | всего | до полуночи | после полуночи | до фикса | после фикса |
|---|---:|---:|---:|---:|---:|
| `successful_edit_loop_warning` | **816** | 483 | 333 | 598 | **218** |
| `successful_edit_loop_blocked` | 11 | 10 | 1 | 10 | **1** |
| `change_contract_preflight` | 10 | 9 | 1 | 9 | **1** |
| `agent_loop_detected` | 1 | 0 | 1 | 1 | **0** |

`successful_edit_loop_warning` — это **97.4%** всех `tool_rejected` (816/838). После фикса — **99.1%** (218/220). Но warning — не единственная неблокирующая категория: всего неблокирующих событий **827/838 (98.7%)** — 816 warning + 10 `change_contract_preflight` + 1 `agent_loop_detected`. Фактически блокирующих только **11** (`successful_edit_loop_blocked`).

### 3.4. Q4 — проекты и инструменты

| project_root | всего | warning | blocked | preflight | loop |
|---|---:|---:|---:|---:|---:|
| `%USERPROFILE%\Desktop\1\launcher_src` | 230 | 225 | 1 | 4 | 0 |
| `C:\mods\1122` | 130 | 130 | 0 | 0 | 0 |
| `C:\forge\forge_1.12.2_full_src` | 85 | 85 | 0 | 0 | 0 |
| `%USERPROFILE%\Desktop\Плакат` | 70 | 70 | 0 | 0 | 0 |
| `C:\forge\deobf_src` | 63 | 61 | 0 | 2 | 0 |
| `D:\321\nvidia` | 58 | 54 | 2 | 2 | 0 |
| `<repo>` | 41 | 41 | 0 | 0 | 0 |
| `%USERPROFILE%\Desktop\1\launcher_src\web` | 37 | 37 | 0 | 0 | 0 |

Заявленные в задаче числа подтверждаются: `launcher_src` 230, `C:\mods\1122` 130, `forge_1.12.2_full_src` 85. Но в `launcher_src` 225 warning + 4 preflight = **229 из 230 неблокирующие**; блокирующее только 1.

| reason | tool | событий |
|---|---|---:|
| `successful_edit_loop_warning` | `edit` | 804 |
| `successful_edit_loop_warning` | `write` | 12 |
| `successful_edit_loop_blocked` | `edit` | 8 |
| `change_contract_preflight` | `edit` | 6 |
| `change_contract_preflight` | `write` | 4 |
| `successful_edit_loop_blocked` | `write` | 3 |
| `agent_loop_detected` | `poster-compiler_poster_status` | 1 |

Аргументы в metadata не сохраняются полностью: есть `file`, `repeats`, `writes`, `edits`, `unique_contents`, `window_ms`. Для `agent_loop_detected` поле `signature` = `null`, то есть повторяемые аргументы не записаны.

### 3.5. D3 — что именно срабатывало

**Warning.** 815 из 816 warning-событий имеют `repeats=3`, `unique_contents=3`; одно — `repeats=3`, `unique_contents=1`. То есть в 99.9% случаев агент сделал три **разные** успешные правки одного файла за 10 минут. Это нормальный цикл «правка → проверка → ещё правка», а не повтор одного и того же действия.

**Прогресс после warning.** Из 816 warning-событий:

- 597 (73.2%) имели хотя бы одну последующую правку того же файла в течение 10 минут;
- распределение числа последующих правок: 0 — 219, 1 — 177, 2–5 — 283, 6+ — 137;
- медиана — 2 правки, максимум — 27.

То есть предупреждение не остановило работу и в большинстве случаев не было реакцией на застой.

**Blocked.** 11 событий:

| дата (MSK) | tool | repeats | unique | writes | streak | файл | правки после |
|---|---|---:|---:|---:|---:|---|---:|
| 2026-09-29 23:27 | write | 3 | 3 | — | — | `code-shadow-loop-guard-smoke.txt` | 0 |
| 2026-09-29 23:36 | write | 3 | 1 | — | — | `code-shadow-adaptive-loop-smoke-2.txt` | 0 |
| 2026-09-30 05:06 | edit | 5 | 5 | — | — | `...\nvidia\nim-proxy\vcf.mjs` | 8 |
| 2026-09-30 05:08 | edit | 5 | 5 | — | — | `...\nvidia\nim-proxy\vcf.mjs` | 3 |
| 2026-09-30 13:52 | edit | 5 | 5 | — | — | `...\launcher\ui\components\Icon.kt` | 0 |
| 2026-09-30 14:06 | edit | 5 | 5 | — | — | `...\launcher\core\launch\LaunchViewModel.kt` | 1 |
| 2026-09-30 14:26 | edit | 5 | 5 | — | — | `...\launcher\ui\routing\ModalRouter.kt` | 4 |
| 2026-09-30 15:13 | edit | 5 | 5 | — | — | `...\launcher\ui\screens\home\ServerList.kt` | 7 |
| 2026-09-30 20:13 | edit | 5 | 5 | — | — | `...\OpenBlocks...\metadeobf.py` | 44 |
| 2026-10-03 14:18 | edit | 5 | 4 | 0 | 0 | `...\veinminer\VeinHandler.java` | 6 |
| 2026-11-13 19:21 | write | 5 | 5 | 5 | 5 | `...\freeact\_debug_import.py` | 0 |

Важно: 7 из 11 `blocked` — это `edit` с пятью **разными** содержимыми, все **до 30.09.2026 20:21** (коммит `0ded2d6` «allow targeted edits after rewrite streaks»). Текущая логика `shouldBlockSuccessfulEditLoop` (см. ниже) такие правки не блокирует: `repeatedContent=false`, а `fullRewriteWithoutProgress` требует `write`. Это исторические ложные срабатывания старой версии guard, а не поведение текущего кода.

Два `write`-блокировки 29.09 — это smoke-файлы `<work>\test\...` (тестовые фикстуры). Ещё два блокирования соответствуют текущей логике: `edit` 03.10 с `repeats=5, unique_contents=4` (есть повтор fingerprint) и `write` 13.11 с `write_streak=5` (пять полных перезаписей одного файла).

**Contract preflight.** 10 событий — это **preflight warning / обнаруженное нарушение контракта, а не блокировка**. Код `src/observer.ts:2064-2071` пишет `tool_rejected` и `log.warn("Preflight Change Contract warning...")`, но не делает `throw` и не выставляет `output.status="deny"`. Catch в `src/observer.ts:2082-2084` пробрасывает только `SuccessfulEditLoopGuardError`; остальные ошибки логируются. Жёсткий gate — это `permission.ask` (`src/observer.ts:950-966`, reason `change_contract_permission_denied`); таких событий в БД **0**. Все 10 preflight-событий сопровождаются успешным `tool_execution` по тому же файлу через **13–46 мс** (10/10), то есть инструмент был выполнен. Из них 6 `edit` / 4 `write`, проекты: `launcher_src`, `forge`, `nvidia`, `<work>\prov`, `<work>\test`. Этим событиям тоже нужен `blocking:false`/`severity:"warning"`.

**Agent loop.** Одно событие 12.11 09:56 MSK: `poster-compiler_poster_status`, **три ошибки одного инструмента в 10-минутном окне** (`inspectToolLoop`, `src/observer.ts:1067-1091`); между ошибками были другие вызовы. Это не «три подряд»: в окне 06:52:01 / 06:52:37 / 06:56:03 UTC между ними шли `poster-compiler_poster_compile`, `bash`, `read`, `edit` и др. Сигнал реальный, но инструмент не блокировался и событие записано как `tool_rejected`.

### 3.6. Q5 — распределение `session_completed`

| событий на сессию | сессий | событий |
|---|---:|---:|
| 1 | 163 | 163 |
| 2–5 | 65 | 181 |
| 6–20 | 48 | 536 |
| 21–50 | 19 | 581 |
| 51–100 | 3 | 202 |
| 100+ | 2 | 240 |
| **Итого** | **300** | **1903** |

Топ-5 сессий:

| сессия | событий | период (UTC) | инструментов в сессии | сообщений |
|---|---:|---|---:|---:|
| `ses_e4dae36e4ffeKzfO73PxmJE3aD` | 124 | 2026-11-06 19:24 – 11-07 19:36 | 2757 | 0 (старая сессия) |
| `ses_e452e8cbfffeXxocC06A3HxO9F` | 116 | 2026-11-08 11:01 – 19:38 | 1636 | 0 (старая сессия) |
| `ses_ef8645a0dfferViPxpHsJDySyi` | 95 | 2026-10-04 15:50 – 10-07 16:40 | — | — |
| `ses_eff15d47affezgV5U2jYRV6E5T` | 55 | 2026-10-03 08:38 – 14:59 | — | — |
| `ses_e29e525d3ffe67nZW87dn0V4m4` | 52 | 2026-11-13 18:10 – 23:00 | 859 | 705 |

У сессии с 124 событиями `duration_ms` в metadata растёт от 20 355 мс до 87 114 089 мс, а `tools_used` — от 10 до 2757. Это не 124 одинаковых «завершения», а 124 последовательных idle-цикла одной долгой сессии.

### 3.7. Q6 — интервалы и настоящие дубли

Всего соседних пар `session_completed` — **1603**.

| показатель | значение |
|---|---:|
| пары в одну секунду (`timestamp/1000` совпадает) | **252** |
| из них до фикса | **252** |
| из них после фикса | **0** |
| пары с интервалом < 1 с | 285 |
| пары < 60 с | 409 |

Последняя пара в одну секунду — **2026-11-12 17:30:44 MSK** (сессия `ses_e2fdcec71ffe666zuIyiV2kr77`). После сборки `dist` (18:51) и коммита (18:59) таких пар нет.

**После фикса (18:59 MSK):**

| показатель | значение |
|---|---:|
| событий | 291 |
| сессий | 99 |
| сессий с >1 событием | 24 |
| соседних пар | 192 |
| пар < 1 с | 0 |
| пар < 5 с | 0 |
| пар 5–60 с | 16 |
| пар 1–10 мин | 115 |
| пар > 10 мин | 61 |
| пар с tool-активностью между событиями | **169 / 192 (88.0%)** |
| пар без tool-активности | 23 / 192 (12.0%) |

**Окно 12.11 00:00–18:59 (до фикса):** 105 событий на 31 сессии, 74 пары, из них 21 пара в одну секунду.

**Определение пар.** Числа **192** и **74** — это пары, у которых **обе границы лежат внутри окна**: для 192 — `prev >= fix` и `curr >= fix`; для 74 — обе метки в `[12.11 00:00, 18:59)`. Если считать по Q6 из 2.3 иначе — только по текущему событию (`curr` в окне, `prev` может быть раньше), получается **193** и **76** соответственно. В таблицах выше использованы 192/74.

### 3.8. Q8 — сверка с `sessions`

У топ-4 примеров ниже `sessions.ended_at` **точно совпадает** с timestamp последнего `session_completed` (delta 0.0 с), статус — `idle`. Но это не универсально: у **7 из 137** сессий с >1 `session_completed` `ended_at` больше последнего события, максимум на **15.36 мин** (`ses_f117bee72ffexZ7RFx6byb6Vp1`: ended_at 2026-09-29 19:15:32 UTC, last event 19:00:11 UTC). Примеры топ-4:

| сессия | событий | `ended_at` = последний event | статус | `duration_ms` |
|---|---:|---|---|---:|
| `ses_e4dae36e4ffeKzfO73PxmJE3aD` | 124 | да, 2026-11-07 19:36:20 | idle | 87 114 089 |
| `ses_e452e8cbfffeXxocC06A3HxO9F` | 116 | да, 2026-11-08 19:38:10 | idle | 31 039 800 |
| `ses_e29e525d3ffe67nZW87dn0V4m4` | 52 | да, 2026-11-13 23:00:19 | idle | 17 373 130 |
| `ses_e2f5e9b3fffeNa61g3ZUtx3cLC` | 32 | да, 2026-11-13 18:10:19 | idle | 91 819 408 |

### 3.9. Живое воспроизведение D3 во время аудита

Пока готовился этот отчёт, БД получила пять новых событий (уже после снимка `id<=3905`); ниже срез на **10:54:59 MSK 14.11.2026** (07:54:59 UTC):

| id | время (UTC) | событие | файл | metadata |
|---:|---|---|---|---|
| 3906 | 2026-11-14 07:38:53 | `tool_rejected` / warning | `tests/v2-events.test.ts` | `repeats=3, unique_contents=3` |
| 3907 | 2026-11-14 07:39:19 | `session_started` | — | новая сессия |
| 3908 | 2026-11-14 07:41:34 | `tool_rejected` / warning | `docs/AUDIT_D3_D4.md` | `repeats=3, writes=0, edits=3, unique_contents=3` |
| 3909 | 2026-11-14 07:43:28 | `session_started` | — | новая сессия |
| 3910 | 2026-11-14 07:52:10 | `tool_rejected` / warning | `docs/AUDIT_D3_D4.md` | `repeats=3, writes=0, edits=3, unique_contents=3` |

Каждое из событий 3908 и 3910 — это третья правка в серии из трёх последовательных правок самого этого отчёта (в двух разных состояниях guard). Все правки успешны, содержимое разное (`unique_contents=3`), но guard записал `tool_rejected` с reason `successful_edit_loop_warning`. Инструмент не был отклонён; отчёт записан. Это прямое живое воспроизведение ложного срабатывания D3: порог «3 правки за 10 минут» не отличает нормальную итеративную работу от цикла.

Срез на **10:54:59 MSK 14.11.2026**: `tool_rejected` = 841, из них warning = 819 (97.4%); после фикса — 223, из них warning 221 (99.1%). Позже появился id 3911 (уже 842/820), в таблицы этого отчёта он не включён. Вывод не меняется.

---

## 4. Вердикт по D3

**На снимке это не 838 реальных циклов агента. 827 из 838 (98.7%) — неблокирующие события, записанные под event_type `tool_rejected`: 816 warning + 10 preflight + 1 agent_loop. Реально блокирующих — только 11.**

Доказательства:

1. **816/838 (97.4%) — `successful_edit_loop_warning`.** Событие создаётся в `src/observer.ts:1139-1156` внутри `recordSuccessfulEdit`, то есть **после успешной** правки. Инструмент не отклоняется, `output.status` не меняется, исключение не бросается. Вызывается из `tool.execute.after` (`src/observer.ts:2170-2173`) только при `status === "success"`.
2. **815/816 warning — три разных содержимых.** `unique_contents=3` означает, что ни один fingerprint не повторился. Это обычная итеративная правка, а не loop. Порог `SUCCESSFUL_EDIT_LOOP_WARNING_COUNT = 3` (`src/observer.ts:107`) срабатывает на любые три правки файла за `SUCCESSFUL_EDIT_LOOP_WINDOW_MS = 10 мин` (`src/observer.ts:106`), без требования повтора.
3. **Warning не останавливает агента.** В 73.2% случаев после warning были последующие правки того же файла в течение 10 минут, медиана — 2 правки. Это прогресс, а не цикл.
4. **Реальных блокировок мало.** 11 `successful_edit_loop_blocked`: 2 — smoke-фикстуры, 7 — старый guard до коммита `0ded2d6` (30.09), который блокировал `edit` с пятью разными содержимыми; текущий код такие правки не блокирует, потому что `shouldBlockSuccessfulEditLoop` (`src/observer.ts:1191-1196`) требует `repeatedContent` или `write`-streak. Ещё 2 блокировки соответствуют текущей логике: `edit` 03.10 с повтором fingerprint и `write` 13.11 со streak=5. После фикса — **одна** реальная блокировка (`write`, 13.11).
5. **Остальные причины — не failure-loop и не блокировки.** 10 `change_contract_preflight` — advisory-warning: `tool_rejected` + `log.warn`, без `throw`/`deny`, и 10/10 сопровождаются успешным tool_execution того же файла через 13–46 мс. 1 `agent_loop_detected` — три ошибки одного инструмента в 10-минутном окне, тоже без блокировки.
6. **Живое воспроизведение.** Пока писался этот отчёт, правки файла `docs/AUDIT_D3_D4.md` дали два новых `successful_edit_loop_warning` (id 3908 и 3910, `unique_contents=3`), хотя все правки были успешны и различны. Это не historical: порог срабатывает на нормальную работу, а не только на старых данных.

По топ-проектам: `launcher_src` 230 = 225 warning + 4 preflight + 1 block (229 неблокирующих); `C:\mods\1122` 130 = все warning; `forge` 85 = все warning. Заголовок «230 tool_rejected в launcher_src» почти полностью сформирован неблокирующими событиями.

**Итог:** failure-loop guard в текущем виде в основном работает как «мягкое предупреждение» и не создаёт реальных циклов; проблема — в таксономии события и слишком чувствительном пороге warning. Если считать KPI «rejection rate» по `tool_rejected`, знаменатель должен быть **11 blocking-событий**: 838/11 = **76.2x**. Если оставить только 2 актуальные не-smoke блокировки текущей логики — 838/2 = **419x**. Неблокирующих — **827/838 (98.7%)**.

---

## 5. Вердикт по D4

**1903 — это не 1903 дубля. Это два разных явления:**

1. **Исторический баг duplicate-write — подтверждён и уже закрыт.** 252 пары `session_completed` в одну секунду, все до фикса; последняя — 12.11.2026 17:30:44 MSK. После фикса — 0 пар < 1 с и 0 пар < 5 с. Это ровно тот сценарий, который закрывает `docs/FIX_PLAN.md:40` и dedupe в `src/observer.ts:1418-1421`.
2. **После фикса поток продолжается, но это не дубли, а per-turn idle.** 291 событие на **99 сессиях с событиями после фикса; 98 из них стартовали после фикса** (исключение — `ses_e2fac59afffexiisEofD2pFOip`, `started_at` 2026-11-12 15:15:05 UTC, до фикса). 24 сессии имеют >1 событие, но между 169 из 192 соседних пар есть tool-активность. У сессии с 124 событиями — 24 часа работы и 2757 tool-вызовов; у сессии с 52 событиями — 705 сообщений и 859 tool-вызовов. `duration_ms` и `tools_used` в metadata монотонно растут — это кумулятивные метрики сессии, а не повторная финализация.

**Почему так происходит (код):**

- `session.idle` dispatcher: `src/observer.ts:773-775`.
- `session.status` со статусом `idle` вызывает **тот же** `handleSessionIdle`: `src/observer.ts:1761-1770`.
- Dedupe: `src/observer.ts:1418-1421` — пропускает только повторный idle, когда сессия **уже** `idle` и `endedAt` уже заполнен.
- Но новое сообщение пользователя переводит сессию обратно в `active`: `src/observer.ts:883-885`; `tool.execute.before` делает то же: `src/observer.ts:2034-2037`.
- Следующий idle снова проходит dedupe (статус `active`), снова пишет `session_completed`: `src/observer.ts:1451-1463`, и обновляет `ended_at`/`duration_ms` кумулятивно.

То есть **live-баг «две записи на один idle» закрыт**, а «много `session_completed` на одну долгую сессию» — это следствие того, что событие называется `session_completed`, но фактически означает «сессия ушла в idle после очередного хода». Судя по обработчику `session.status` (`busy`/`idle`) и данным, idle наступает после каждого хода агента, а не только при закрытии сессии.

**Покрывает ли фикс P0.2/P2 этот сценарий?**

- P0.2 (`docs/FIX_PLAN.md:40`) — да, но только literal duplicate: «повторный idle дублирует события». Именно это и исправлено; после фикса same-second пар нет.
- P2 (`docs/FIX_PLAN.md:63`) — про per-instance state и TTL `toolLoopMap`; к D4 в этом срезе не относится. Кросс-процессный race здесь не наблюдался.
- Многотуровый сценарий (chat.message → active → idle → chat.message → active → idle) тестом не покрыт: `tests/observer.test.ts:657-681` проверяет только два idle подряд **без** нового сообщения и ожидает `count=1`.

**Итог:** если `session_completed` должен означать «сессия завершена», код всё ещё завышает метрику: после фикса 291 событие на **99 сессиях с событиями** (98 из них стартовали после фикса) = **2.94 события на сессию**. Если событие означает «ход завершён» — данные корректны, но имя и потребители (`src/tools/analyze.ts:608`, где `session_completed` смешан с `session_end`) вводят в заблуждение.

---

## 6. Рекомендации

### P1 — метрики, которые нельзя оставлять как есть

1. **Разделить неблокирующие сигналы и rejection.** В `src/observer.ts:1141-1156` событие `successful_edit_loop_warning` пишется как `tool_rejected`, хотя инструмент успешен. То же относится к `change_contract_preflight` (`src/observer.ts:2064-2071`) и `agent_loop_detected` (`src/observer.ts:1083-1090`): оба не блокируют инструмент. Минимальная правка без изменения схемы: добавить в metadata `blocking: false`, `severity: "warning"` для всех трёх reason и исключить их из KPI отказов. Полная правка: миграция 012, добавить `tool_warning` в CHECK `developer_events.event_type` и писать туда warning + preflight; `agent_loop_detected` — отдельный тип. Тогда из rejection-метрики уйдут **826 событий** (warning + preflight), а с `agent_loop_detected` — **827**; останутся только 11 blocking. Фильтр `reason != 'successful_edit_loop_warning'` неполный: нужен единый флаг `blocking`/`severity` для всех неблокирующих reason.
2. **Определить семантику `session_completed`.** Если это «сессия завершена» — в `src/observer.ts:1451-1463` нужно писать событие один раз на сессию (проверка существующего `session_completed` или upsert), а не на каждый idle. Если это «ход завершён» — переименовать в `session_idle`/`turn_completed` (или добавить `metadata.kind="turn"`, `turn_index`) и обновить `src/tools/analyze.ts:608` и дашборды. Сейчас метрика «completed sessions» завышена примерно в 3 раза.
3. **Не считать `agent_loop_detected` и `change_contract_preflight` отказами.** `agent_loop_detected` (`src/observer.ts:1083-1090`) фиксирует три ошибки одного инструмента в 10-минутном окне, но ничего не блокирует; `signature=null` не позволяет проверить повтор. `change_contract_preflight` — advisory-warning, инструмент выполняется. Обоим нужен `blocking:false` (и отдельный event type для loop-сигнала).

### P2 — снизить ложные срабатывания guard

4. **Сделать warning progress-aware.** Сейчас warning срабатывает на 3 любые правки. Минимально: требовать `repeatedContent` (fingerprint >= 2) или `writeStreak >= 3` и до этого не предупреждать. Альтернатива — поднять `SUCCESSFUL_EDIT_LOOP_WARNING_COUNT` до 5 и/или увеличить окно для warning. Это уберёт основную массу 815 «трёх разных правок».
5. **Сделать dedupe атомарным.** Проверка `getSession` → `updateSessionStatus` в `handleSessionIdle` не транзакционна. При двух процессах/плагинах возможен race. Если `session_completed` остаётся session-level, добавить частичный UNIQUE index на `(session_id, event_type)` для `session_completed` или `INSERT ... WHERE NOT EXISTS`. Если turn-level — добавить `(session_id, turn_index)`.

### P3 — гигиена и проверки

6. **Добавить regression-тесты:** (а) warning при трёх разных содержимых не должен считаться rejection; (б) `session.idle` + `session.status(idle)` одновременно не создают два события; (в) multi-turn: chat.message → idle → chat.message → idle должен давать либо 2 turn-события, либо 1 session-событие — в зависимости от выбранной семантики.
7. **Исторические данные не переписывать.** Для дашбордов фильтровать по `blocking`/`severity` (а не только по `reason != 'successful_edit_loop_warning'`, потому что preflight и agent_loop тоже неблокирующие) и/или по `timestamp >= 1794499165000` (фикс); помечать pre-fix события как legacy при следующей миграции.
8. **Документировать таксономию** в `docs/DATA_MODEL.md`: что означает `tool_rejected`, `successful_edit_loop_warning`, `session_completed`, и какие из них блокирующие.

---

## 7. Что осталось непроверенным

- **23 пары после фикса без tool-активности.** Это могут быть text-only ходы (агент ответил без инструментов) или остаточные повторные idle. В `developer_events` нет `message.updated`, поэтому по БД их не различить; нужен лог событий OpenCode или `message_count` на момент пары.
- **Кросс-процессный race.** Мы видим отсутствие same-second дублей после фикса, но не проверяли два одновременно запущенных plugin-процесса. Dedupe в коде не транзакционен.
- **Какой именно build загружал host.** В `dist/observer.js` (18:51) dedupe есть, но мы не смотрели логи OpenCode, чтобы подтвердить, что после 18:59 работал именно он, а не `src/`.
- **Содержимое Change Contract preflight.** 10 preflight-warning'ов не сверялись построчно с `allowed_paths`/`forbidden_paths` конкретного контракта; проверено только, что инструмент после них выполняется.
- **Потребители `session_completed` за пределами `src/`.** Проверены `src/tools/analyze.ts:608` и типы; TUI/внешние дашборды не аудировались.
- **Часовой пояс.** Все timestamp считались UTC; MSK+3 выведен из дат коммитов и локального окружения. Если host писал время в другой зоне, границы сдвинутся, но вывод по D4 устойчив: последний same-second дубль — 17:30 MSK, задолго до фикса.

---

## 8. Приложение: проверочные SQL после правок

Все запросы — read-only. 8.1–8.5 используют `developer_events WHERE id <= 3905` (снимок 3905 событий, max timestamp 2026-11-14 07:30:53 UTC); в 8.4 дополнительно есть lookup по `sessions`, которые существовали на снимке. 8.6 использует live-таблицу `tool_executions` и ограничен временным окном, поэтому `id <= 3905` к ней неприменим.

### 8.1. Blocking vs non-blocking

```sql
SELECT CASE
         WHEN json_extract(metadata,'$.reason') = 'successful_edit_loop_blocked'
           THEN 'blocking' ELSE 'non-blocking'
       END AS class,
       COUNT(*) AS c
FROM developer_events
WHERE id <= 3905 AND event_type = 'tool_rejected'
GROUP BY class;
```

| class | c |
|---|---:|
| blocking | 11 |
| non-blocking | 827 |
| **итого** | **838** |

Разбивка non-blocking: `successful_edit_loop_warning` 816 + `change_contract_preflight` 10 + `agent_loop_detected` 1 = 827 (98.69%).  
`838 / 11 = 76.18x`; `838 / 2 = 419x` для двух актуальных не-smoke блокировок.

### 8.2. Preflight — warning, а не hard gate

```sql
SELECT COUNT(*) FROM developer_events
WHERE event_type = 'tool_rejected'
  AND json_extract(metadata,'$.reason') = 'change_contract_permission_denied';
-- 0
```

Все 10 preflight-событий имеют успешный `tool_execution` по тому же файлу сразу после события:

```sql
SELECT e.id, e.timestamp, e.file_path,
       MIN(t.timestamp) - e.timestamp AS delta_ms,
       t.status
FROM developer_events e
JOIN tool_executions t
  ON t.session_id = e.session_id
 AND t.target_file = e.file_path
 AND t.timestamp > e.timestamp
WHERE e.id <= 3905
  AND e.event_type = 'tool_rejected'
  AND json_extract(e.metadata,'$.reason') = 'change_contract_preflight'
GROUP BY e.id
ORDER BY e.timestamp;
```

| id | delta_ms | status | файл (маска) |
|---:|---:|---|---|
| 81 | 25 | success | `<work>\test\code-shadow-loop-guard-smoke.txt` |
| 85 | 23 | success | `<work>\prov\test_verify.py` |
| 376 | 46 | success | `%USERPROFILE%\Desktop\1\launcher_src\settings.gradle.kts` |
| 377 | 27 | success | `%USERPROFILE%\Desktop\1\launcher_src\build.gradle.kts` |
| 393 | 13 | success | `%USERPROFILE%\Desktop\1\launcher_src\src\main\proto\update.proto` |
| 659 | 41 | success | `<work>\nvidia\nim-proxy\verify-kimi-tools.mjs` |
| 825 | 33 | success | `%USERPROFILE%\Desktop\1\launcher_src\src\main\kotlin\net\mcsgroup\launcher\ui\components\SmoothScroll.kt` |
| 1609 | 16 | success | `C:\forge\forge_1.12.2_full_src\net\minecraft\world\gen\layer\IntCache.java` |
| 1661 | 23 | success | `C:\forge\forge_1.12.2_full_src\net\minecraft\entity\EntityLiving.java` |
| 3037 | 30 | success | `<work>\nvidia\nim-client.mjs` |

Итог: **10/10**, задержка **13–46 мс**, все `status=success`. Это подтверждает: preflight не блокирует инструмент.

### 8.3. Две актуальные не-smoke блокировки

```sql
SELECT timestamp, file_path,
       json_extract(metadata,'$.tool') AS tool,
       json_extract(metadata,'$.repeats') AS repeats,
       json_extract(metadata,'$.unique_contents') AS uniq
FROM developer_events
WHERE id <= 3905
  AND event_type = 'tool_rejected'
  AND json_extract(metadata,'$.reason') = 'successful_edit_loop_blocked'
  AND timestamp > 1790788875000          -- 0ded2d6, 2026-09-30 17:21:15 UTC
  AND file_path NOT LIKE '%\codex\test\%'
ORDER BY timestamp;
```

| timestamp (UTC) | tool | repeats | uniq | файл |
|---|---|---:|---:|---|
| 2026-10-03 11:18:24 | edit | 5 | 4 | `%USERPROFILE%\AppData\Local\Temp\...\VeinHandler.java` |
| 2026-11-13 16:21:11 | write | 5 | 5 | `%USERPROFILE%\freeact\_debug_import.py` |

Остальные 9 blocking-событий: 7 — старый guard до `0ded2d6` (`edit`, 5 разных содержимых), 2 — smoke-фикстуры `<work>\test\...`.

### 8.4. D4: 99 сессий с событиями после фикса, 98 стартовали после фикса

```sql
-- 99
SELECT COUNT(DISTINCT session_id) FROM developer_events
WHERE id <= 3905
  AND event_type = 'session_completed' AND timestamp >= 1794499165000;

-- 98
SELECT COUNT(*) FROM sessions s
WHERE s.started_at >= 1794499165000
  AND EXISTS (SELECT 1 FROM developer_events e
              WHERE e.session_id = s.id
                AND e.id <= 3905
                AND e.event_type = 'session_completed'
                AND e.timestamp >= 1794499165000);

-- контрпример (lookup по sessions; строка существовала на снимке)
SELECT id, started_at FROM sessions
WHERE id = 'ses_e2fac59afffexiisEofD2pFOip';
-- started_at = 2026-11-12 15:15:05 UTC, до фикса
```

### 8.5. `ended_at` больше последнего события: 7 из 137

```sql
SELECT COUNT(*) FROM (
  SELECT s.id, s.ended_at,
         (SELECT MAX(timestamp) FROM developer_events e
           WHERE e.id <= 3905
             AND e.session_id = s.id AND e.event_type = 'session_completed') AS last_ts
  FROM sessions s
  WHERE (SELECT COUNT(*) FROM developer_events e
          WHERE e.id <= 3905
            AND e.session_id = s.id AND e.event_type = 'session_completed') > 1
)
WHERE ended_at > last_ts;
-- 7
```

Максимальная дельта — **15.36 мин**: `ses_f117bee72ffexZ7RFx6byb6Vp1`, `ended_at` 2026-09-29 19:15:32 UTC, последнее событие 19:00:11 UTC.

### 8.6. `agent_loop_detected`: три ошибки в окне, не «подряд»

`tool_executions` — live-таблица; `id <= 3905` относится к `developer_events` и здесь неприменим. Запрос ограничен временным окном 06:46:03–06:56:04 UTC.

```sql
SELECT timestamp, tool_name, status
FROM tool_executions
WHERE session_id = 'ses_e317909efffeF71AMZOc0FSFRP'
  AND tool_name = 'poster-compiler_poster_status'
  AND timestamp BETWEEN 1794465963947 AND 1794466564947
ORDER BY timestamp;
```

| timestamp (UTC) | tool | status |
|---|---|---|
| 2026-11-12 06:52:01 | poster-compiler_poster_status | error |
| 2026-11-12 06:52:37 | poster-compiler_poster_status | error |
| 2026-11-12 06:56:03 | poster-compiler_poster_status | error |

Между 06:52:01 и 06:52:37, а также между 06:52:37 и 06:56:03 выполнялись другие инструменты (`poster-compiler_poster_compile`, `bash`, `read`, `edit` и др.). Событие создано на третьей ошибке в 10-минутном окне и инструмент не блокировало.
