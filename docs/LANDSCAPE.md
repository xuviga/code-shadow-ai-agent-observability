# Ландшафт решений: что уже придумано в мире для болей AI-агентов

> Дата: 17.11.2026. Область: coding-агенты, observability, безопасность MCP,
> память, ревью, provenance, стоимость, мультиагентная координация.
> Цель документа — честно сопоставить Code Shadow с существующими решениями
> и зафиксировать, где наши заявления подтверждаются, а где нет.

---

## 0. Главный вывод в одном абзаце

Почти каждая функция Code Shadow **уже существует** — либо как зрелый коммерческий
продукт, либо как исследовательская работа 2026 года. Уникальность не в отдельных
кирпичах, а в трёх вещах: (1) всё работает **локально внутри рантайма агента**, без
SaaS и сети; (2) доказательства **связаны с правом агента сказать «готово»** —
Definition of Done не проходит без sealed passport; (3) один объект связывает
intent → файлы → findings → контракты → evidence → claims → бюджет → hash-chain →
review packet. Формулировку «никто в мире этого не сделал» надо заменить на
«исследования описали идею, но в шипящем dev-инструменте для coding-агента такой
гейт мне найти не удалось».

---

## 1. Что уже создано — по болям

### 1.1. Наблюдаемость и трейсинг агентов

| Решение | Что даёт | Ограничение |
|---|---|---|
| **LangSmith** (LangChain) | Трейсы, Insights (кластеризация трейсов), мониторинг cost/trajectory, алерты | Проприетарный, self-host только Enterprise |
| **Langfuse** (MIT, куплен ClickHouse, янв. 2026) | Трейсы, evals, prompt management, датасеты, self-host | Нужно эксплуатировать ClickHouse + Postgres + Redis |
| **MLflow** (Apache 2.0, Linux Foundation) | 60+ интеграций через OTel, tracing + eval + governance | Не заточен под coding-агентов |
| **Arize Phoenix / AX** | OTel/OpenInference, 50+ метрик, drift | Phoenix — Elastic License 2.0; live-monitoring в платном AX |
| **Braintrust** | Eval-loop, CI/CD-гейты, «баг из прода → строка датасета» | Нет open-source |
| **Opik** (Apache 2.0) | Трейсы + evals + guardrails, дешёвый cloud | Меньше глубина по коду |
| **Helicone / AgentOps / Laminar / Traceloop / HoneyHive / Logfire** | Прокси-трейсинг, session replay, OTel-инструментация | Каждый покрывает часть стека |

**Стандарт де-факто:** OpenTelemetry GenAI semantic conventions (v1.41: `invoke_agent`,
`execute_tool`, MCP-конвенции, `gen_ai.usage.*`). Инструментируешься один раз —
данные уходят в любой бэкенд.

**Вывод для Code Shadow.** Наш `developer_events` + TUI — это локальный,
приватный, упрощённый вариант observability. Не новизна. Но у нас есть то, чего
нет у трейсеров: **запись связана с решением «пропустить/заблокировать»**, а не
только с просмотром. Слабость: мы не экспортируем `gen_ai.*` и несовместимы с OTel,
поэтому не можем быть «вторым экраном» рядом с Langfuse — только заменой.

### 1.2. Память и контекст

| Решение | Модель памяти |
|---|---|
| **Mem0** | Извлечение фактов в векторный store, drop-in слой |
| **Zep / Graphiti** | Би-темпоральный граф: когда факт стал истинным и когда перестал |
| **Letta (MemGPT)** | Агент сам редактирует свои memory-блоки, git-backed MemFS |
| **Cognee** | Граф знаний из документов/кода, self-improving |
| **Supermemory / LangMem / LightMem / Hindsight** | Векторные, затухающие, сжатые варианты |
| **AGENTS.md** (agents.md) | Открытый формат инструкций, 60k+ проектов, читают Codex, Cursor, Gemini CLI, Claude Code |

**Вывод для Code Shadow.** `knowledge_nodes` + FTS5 + auto-memory — это
самодельный Mem0/Cognee уровня «локально и бесплатно». Не новизна. Наше
преимущество — память **про этот проект и этого агента** без внешнего сервиса.
Слабость: нет темпоральности (когда факт перестал быть верным), нет дедупликации
на уровне смысла, нет выбора «что вернуть в контекст» по задаче.

### 1.3. Безопасность MCP и доверие инструментам

| Решение | Механизм |
|---|---|
| **mcp-scan** (Invariant Labs) | Tool pinning через хеши описаний, детект rug pull, tool poisoning, shadowing |
| **MCPGuard** (arXiv 2510.23673) | Автоматический поиск уязвимостей MCP-серверов |
| **Инвариант «tool poisoning»** | Вредоносные инструкции в описании/параметрах/ошибках инструмента |
| **Pillar Security / Zenity / Lakera / Prisma AIRS / Invariant Gateway** | Runtime-политики на AI-gateway: блокировка tool call, PII, prompt injection |
| **agentgateway (Solo.io)** | Токен-бюджеты на команду/агента, `budget_exhausted` |

**Вывод для Code Shadow.** Наш `tool_trust` (migration 014) — это **реализация
tool pinning из mcp-scan**, встроенная в плагин и связанная с runtime-политикой
(`warn`/`block`) на `tool.execute.before`. Идея не наша. Отличие: mcp-scan —
отдельный сканер по расписанию, у нас — постоянный пиннинг + блокировка вызова
внутри агента, бесплатно и локально. Слабость: мы не проверяем **выход** инструмента
и не ловим переменную инъекцию (variable poisoning), которую академия уже описала.

### 1.4. Ревью кода и «почти правильный» код

| Решение | Сила | Слабость |
|---|---|---|
| **CodeRabbit** | Точность, 40+ линтеров, мало шума (~46% detection, 2 FP на 118 багов) | Пропускает то, что ловят шумные инструменты |
| **Greptile** | Индекс всего репозитория, ~82% на своём бенчмарке | Много FP (~11 на том же наборе) |
| **Qodo** | Мульти-агентное ревью + генерация тестов, F1 ~60% | Дороже, привязка к платформе |
| **cubic / Macroscope / Cursor Bugbot / Graphite / PR-Agent / Semgrep** | Разные компромиссы recall/precision, self-host, SAST | Каждый покрывает часть |

**Важная цифра:** анализ 54 713 комментариев агентов в 341 репозитории — **27–45%
замечаний остаются неразрешёнными**, чаще всего как «неверное suggestion» или
«намеренное решение». То есть проблема не в том, что агент мало находит, а в том,
что человек перестаёт читать.

**Вывод для Code Shadow.** Наш regex-сканер почти правильного кода **значительно
слабее** любого из этих продуктов по обнаружению багов. Это не ревьюер, это
дешёвый детерминированный «smell-gate» на добавленных строках. Позиционировать
его как замену CodeRabbit/Greptile нельзя. Его настоящая роль — ловить
**самообман агента** (отключённый тест, `|| true`, пустой catch), а не баги
бизнес-логики.

### 1.5. Provenance, аттестация, аудит

| Решение | Что делает |
|---|---|
| **SLSA / in-toto / Sigstore / DSSE** | Подписанные attestations, цепочка шагов supply chain, верификация политикой |
| **Model Transparency (OpenSSF/Sigstore)** | Подпись моделей и их артефактов |
| **AIBOM (Codacy, 2026)** | Инвентаризация AI-ресурсов и доказательств для аудита |
| **CoSAI AI supply chain maturity model** | Уровни: инвентарь → подписанное утверждение → continuous enforcement |
| **Agentic process evidence (arXiv 2610.40071)** | in-toto-подобное process-aware логирование для governance агентов |

**Вывод для Code Shadow.** Наш `hash`/`prevHash` — это **tamper-evident цепочка
без подписи и без identity**. Она доказывает «эта запись не менялась в этой БД»,
но не «этот паспорт выпустил именно этот агент/человек в это время». По шкале
CoSAI мы находимся на уровне 1–2, а не 3. Это надо честно писать, и это первое,
что надо чинить (см. §4).

### 1.6. Исследования, которые прямо описывают идею «паспорта изменения»

Это самое важное для честности:

1. **PCAA — Proof-Carrying Agent Actions** (arXiv 2606.04104, июнь 2026).
   Runtime-neutral governance: action certificate вместо vendor-записи сессии.
   Пять чекпойнтов: pre-action admissibility → action open → assumption capture →
   approval → outcome closure; action envelope, runtime/approval receipts,
   replay-ready proof. Это **обобщение нашего паспорта на все действия агента**.
2. **Assurance Envelopes for Autonomous Coding Agents** (arXiv 2609.16302,
   сентябрь 2026). Формально: какие обязательства (obligations) должно сохранить
   изменение и какой **минимальный набор доказательств** их восстанавливает;
   typed inference graph + CP-SAT; медиана решения < 20 мс на графах из 500
   evidence. Это **более сильная версия нашего `checks`**: не фиксированный
   чеклист, а выбор доказательств под задачу.
3. **Proof-Oriented Programming with AI Agents** (ACM, 2026). Агент выдаёт код
   вместе с machine-checked proof; человек ревьюит спецификацию, а не реализацию.
4. **Agentic process evidence** (arXiv 2610.40071). Attestation-фреймворк для
   процесса работы агента, совместимый с in-toto.
5. **Cryptographic Governance for Autonomous AI Agents** (2026). Action-bound
   governance, ссылается на PCAA как на смежную работу.

**Вывод.** Идея «изменение агента должно нести проверяемые доказательства»
**уже сформулирована и исследуется**. Мой прежний тезис «никто в мире не сделал»
неверен на уровне концепции. Верно более узкое: **шипящего dev-инструмента,
который заставляет coding-агента пройти этот гейт локально перед словом «готово»,
я не нашёл**.

### 1.7. Мультиагентная координация

| Решение | Механизм |
|---|---|
| **Claude Code Agent Teams** | Общий task list с `blockedBy`, file-lock claiming, git worktree на тиммейта |
| **OpenAI Codex** | Отдельный worktree на поток агента |
| **Conductor (Melty Labs)** | Параллельные Claude Code/Codex в своих worktree, diff-first review |
| **Cursor (community)** | Атомарные claim-файлы в `.cursor/worktrees.json` |
| **Git worktrees как практика** | Изоляция вместо блокировок; «split the work correctly» |

**Вывод для Code Shadow.** `file_claims` — это plugin-level реализация того же
примитива, что file-lock claiming в Agent Teams, но **без worktree-изоляции**.
Наш плюс: работает между независимыми сессиями и сабагентами на одном хосте,
с автоматическим перехватом брошенных claims. Наша слабость: кооперативность и
время жизни; при реальном параллельном письме worktree надёжнее.

### 1.8. Стоимость

| Решение | Что делает |
|---|---|
| **agentgateway** | Бюджеты по scope/period, жёсткий `budget_exhausted` |
| **Portal26 / rate limits** | Троттлинг, пауза, терминация runaway-петель |
| **Практика 2026** | Uber: $1 500/инженер/месяц; кейс 10 млрд токенов на $100-плане |

**Вывод.** Наш `budget_tokens` — **предупреждение, не гейт**. Это слабее
рыночного стандарта. Runaway loop — задокументированная боль №1 по деньгам.

### 1.9. Качество и бенчмарки

- SWE-bench Verified насыщен: топы 95–97%.
- Аудит: **19.78% «решённых» кейсов семантически неверны** — проходят тесты
  случайно или через reward hacking.
- Terminal-Bench 4.0, SWE-bench Pro (41 репозиторий, ~107 строк / 4.1 файла).
- TDAD (arXiv 2603.17973): graph-based test impact analysis снижает регрессии
  на 70% (6.08% → 1.82%).

**Вывод.** Наш DoD — это **локальная согласованность**, а не измерение качества.
Нельзя заявлять, что паспорт делает код правильным.

### 1.10. Регуляторика (почему это вообще покупают)

- **EU AI Act**: основные обязательства high-risk (ст. 9–17, 26) и прозрачность
  (ст. 50) — с **2 августа 2026**.
- Аудиторы спрашивают: что сгенерировано, какой моделью, какая политика
  применялась **в точке изменения**, где доказательства.
- Ответ рынка: AIBOM, AI Risk Hub (Codacy), SAIL-маппинг (Pillar) на ISO 42001 /
  NIST AI RMF / OWASP / MITRE ATLAS, git-трейлеры авторства (Claude Code).

**Вывод.** Спрос на «доказательство на каждое изменение» реален и регуляторно
подкреплён. Это сильная сторона нашей позиции — но конкуренты уже продают
compliance-обвязку enterprise-уровня.

---

## 2. Сопоставление: Code Shadow vs мир

| Боль | Лучшее существующее решение | Что у Code Shadow | Честная оценка |
|---|---|---|---|
| Наблюдаемость | LangSmith, Langfuse, OTel GenAI | SQLite + TUI, 19 событий | Слабее по глубине, выигрывает локальностью |
| Память | Mem0, Zep, Letta, Cognee | JSONL/DB факты + FTS | Слабее, но без внешнего сервиса |
| MCP trust | mcp-scan + AI gateways | `tool_trust` + policy block | Паритет по идее, слабее по охвату |
| Ревью кода | CodeRabbit, Greptile, Qodo | regex smell-сканер | **Существенно слабее** |
| Guardrails | LlamaFirewall, NeMo, Lakera | firewall shell-команд | Уже, но детерминированный и локальный |
| Provenance | SLSA, in-toto, Sigstore | hash-chain без подписи | **Слабее по доказуемости** |
| Мультиагентность | Agent Teams, worktrees | file_claims + stale takeover | Проще, без изоляции |
| Стоимость | agentgateway budgets | warning по бюджету | **Слабее (нет гейта)** |
| Evidence-гейт «готово» | research: PCAA, assurance envelopes | sealed passport в DoD | **Сильная, редкая позиция** |
| Локальность/приватность | почти никто из лидеров | by design | **Реальное отличие** |

---

## 3. Где мы действительно впереди

1. **Гейт, а не дашборд.** Observability показывает, review комментирует,
   guardrails фильтрует I/O. Мы **не даём агенту завершить задачу** без
   проверяемого пакета. Это поведенческое изменение, а не отчёт.
2. **Один объект на изменение.** В одном месте: intent, файлы + SHA-256,
   findings, контракт, evidence, claims, бюджет, hash-chain, review Markdown.
   В мире это разложено по 4–5 продуктам и не собирается в один артефакт.
3. **Локально и без сети.** Приватный код не покидает машину, работает офлайн,
   бесплатно. LangSmith/Braintrust/CodeRabbit — SaaS; Langfuse/Opik — инфраструктура.
4. **Внутри рантайма агента.** Мы видим `tool.execute.before` и можем
   *остановить* действие до выполнения. Внешний сканер или PR-бот так не может.
5. **Совместимость с идеей assurance envelope.** Наш `checks` — заготовка под
   выбор доказательств; если добавить obligations, мы окажемся впереди шипящих
   инструментов (но позади research).

---

## 4. Что надо исправить, чтобы заявления были правдой

### P0 — доверие и доказуемость

1. **Подпись паспорта.** DSSE/in-toto-совместимый envelope + Sigstore/cosign,
   если доступен; иначе — Ed25519-ключ проекта. Без подписи hash-chain — это
   контрольная сумма, а не provenance.
2. **Identity.** Кто выпустил: агент, модель, пользователь, хост. Сейчас `agent`
   и `model` почти всегда пустые.
3. **Экспорт в in-toto/SLSA-подобный predicate** + `subject` с git commit.
   Тогда паспорт читается аудитором и CI, а не только нами.

### P0 — деньги и петли

4. **Жёсткий бюджет.** `budget_tokens` → блокировка следующего шага при
   превышении (`budget_exhausted`), а не warning. Плюс детект runaway loop по
   стоимости за окно.

### P1 — качество доказательств

5. **Assurance envelope вместо чеклиста.** Обязательства изменения (какие
   свойства должны сохраниться) → минимальный набор evidence. Это
   research-backed апгрейд (arXiv 2609.16302), которого нет у шипящих продуктов.
6. **Настоящая верификация вместо regex.** Запуск typecheck/tests по затронутым
   пакетам (test impact analysis, TDAD), адаптер Semgrep/CodeQL. Regex-находки
   оставить как `info`, не как основание для `blocked`.

### P1 — совместимость

7. **OTel GenAI export** (`invoke_agent`, `execute_tool`, `gen_ai.usage.*`) —
   чтобы Code Shadow был дополнением к Langfuse/LangSmith, а не островом.
8. **AGENTS.md** — использовать как основной канал инструкций (уже частично),
   не изобретать свой формат.

### P2 — мультиагентность и оценка

9. **Worktree-изоляция** или merge-aware claims для параллельного письма.
10. **Eval-корпус паспорта**: набор «почти правильных» изменений с ожидаемым
    вердиктом; precision/recall сканера вместо прилагательных.
11. **Проверка выхода инструментов** (prompt injection в tool output, variable
    poisoning) — сейчас не покрыто.

---

## 5. Позиционирование, которое выдерживает проверку

**Плохо:** «единственный в мире», «никто не сделал», «закрывает все боли».

**Хорошо:** «локальный, приватный, встроенный в рантайм агента слой
доказательств: агент не может сказать "готово" без проверяемого паспорта
изменения. Идея опирается на research 2026 (proof-carrying actions, assurance
envelopes) и стандарты in-toto/SLSA; в отличие от SaaS-трейсеров и PR-ботов,
работает офлайн, бесплатно и до выполнения действия».

**Рынок:** категория консолидируется и хорошо профинансирована (CodeRabbit —
$1.5B, ClickHouse купил Langfuse, Dynatrace покупает Arize, Vanta — Pillar).
Выигрывать в ширине бессмысленно. Выигрывать можно в узкой нише: **приватность +
гейт + открытый формат аттестации**.

**Стратегия:** не заменять CodeRabbit/Langfuse/Semgrep, а **принимать их сигналы**
в паспорт как evidence и **отдавать** паспорт в OTel/in-toto. Тогда Code Shadow —
это слой, который превращает чужие проверки в право сказать «готово».

---

## 6. Источники

**Observability**
- https://mlflow.org/top-5-agent-observability-tools/
- https://www.vellum.ai/blog/best-ai-agent-observability-tools
- https://latitude.so/blog/best-llm-observability-tools-agents-latitude-vs-langfuse-langsmith
- https://gigabit.agency/insights/ai-agent-observability-tools/
- https://opentelemetry.io/blog/2026/genai-observability/
- https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions
- https://www.morphllm.com/agent-tracing

**Память**
- https://dosu.dev/articles/best-ai-agent-memory-tools-2026
- https://theaiengineer.substack.com/p/cognee-vs-zep-vs-mem0-vs-letta
- https://vectorize.io/articles/best-ai-agent-memory-systems
- https://agents.md/

**MCP / безопасность**
- https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks
- https://invariantlabs.ai/blog/introducing-mcp-scan
- https://arxiv.org/html/2510.23673v1
- https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-ai-agent-exfiltration-2/
- https://www.pillar.security/blog/best-ai-governance-platforms-2026
- https://www.solo.io/blog/building-real-time-ai-cost-controls-with-agentgateway

**Ревью кода**
- https://levelop.dev/blog/best-ai-code-review-tools-2026-coderabbit-greptile-qodo-compared
- https://coderbuds.com/blog/ai-code-review-tools-comparison-2026
- https://resources.rework.com/tools/ai-coding/best-ai-code-review-tools-2026
- https://arxiv.org/html/2607.21997v1 (54 713 комментариев агентов)

**Guardrails**
- https://www.turingpost.com/p/aisecuritytools
- https://ai.meta.com/research/publications/llamafirewall-an-open-source-guardrail-system-for-building-secure-ai-agents/
- https://github.com/NVIDIA-NeMo/Guardrails

**Provenance / аудит**
- https://slsa.dev/blog/2023/05/in-toto-and-slsa
- https://www.coalitionforsecureai.org/how-much-assurance-does-your-ai-supply-chain-need/
- https://arxiv.org/html/2610.40071v1
- https://blog.codacy.com/what-auditors-will-ask-about-ai-generated-code-in-2026
- https://www.augmentcode.com/tools/ai-coding-tools-eu-ai-act-compliance

**Research: proof-carrying / assurance**
- https://arxiv.org/abs/2606.04104 (PCAA)
- https://arxiv.org/abs/2609.16302 (Assurance Envelopes)
- https://dl.acm.org/doi/10.1145/3828709 (Proof-Oriented Programming with AI Agents)

**Мультиагентность**
- https://addyosmani.com/blog/code-agent-orchestra/
- https://alexlavaee.me/blog/parallel-agent-sessions-infrastructure-gap/
- https://www.mindstudio.ai/blog/claude-code-agent-teams-shared-task-list

**Spec-driven**
- https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
- https://github.com/github/spec-kit
- https://kiro.dev/

**Бенчмарки / регрессии**
- https://www.swebench.com/
- https://www.tbench.ai/
- https://arxiv.org/html/2603.17973v1 (TDAD)
- https://specstory.com/learning/ci-cd/test-impact-analysis

**Стоимость**
- https://goremy.ai/blog/articles/real-cost-of-ai-coding-agents-and-how-to-cap-it
- https://blog.sondera.ai/p/ai-agent-token-costs-security-risk
- https://www.cockroachlabs.com/blog/agentic-ai-costs-at-scale/
