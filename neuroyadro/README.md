# НейроЯдро

**НейроЯдро** — локальная русскоязычная decoder-only модель и кроссплатформенное приложение. Репозиторий ранее содержал материалы другого продукта (`ShopSim.*`); реализация НейроЯдра находится целиком в этой папке и не использует его бинарные файлы.

## Что реализовано — этапы 0–1 (MVP)

- LLaMA-совместимое (RMSNorm, RoPE, SwiGLU, causal attention) ядро **24,6M обучаемых параметров**: 10 слоёв, hidden size 416, 8 голов, контекст 1024, BPE-словарь 8 000;
- подготовка локального русскоязычного корпуса в SentencePiece BPE и токенизированные блоки;
- CPU/GPU-скрипт обучения с детерминированными батчами, атомарными чекпоинтами, автопродолжением и журналом метрик;
- экспорт чекпоинта в Hugging Face Llama-совместимую папку и затем в GGUF через локальную копию `llama.cpp`;
- тесты конфигурации, формы модели, каузальности, HF-совместимости и протокола чекпоинта; demo smoke-test прошёл до GGUF;
- исходный код Qt 6/QML desktop MVP в [`app/`](app/): локальные чаты SQLite, потоковый GGUF runtime llama.cpp, метрики, слайдер раздумывания, валидированные карточки уточнений, локальная суммаризация контекста и анти-повтор.

Это **не обещание качества от демонстрационного корпуса**: `data/raw/demo_ru.txt` предназначен только для smoke-test. Добавлен memory-mapped pipeline для больших токенизированных shards и manifest открытых кандидатов. Инструкции и ограничения: [docs/OPEN_SOURCES.md](docs/OPEN_SOURCES.md), [docs/DATA_AND_TRAINING.md](docs/DATA_AND_TRAINING.md). Стабильные Windows/APK релизы определены только для tag-based CI и пока не опубликованы: [docs/RELEASES.md](docs/RELEASES.md).

## Быстрый запуск (proof of concept)

Требуются Python 3.10+ и PyTorch. На Linux/macOS:

```bash
cd neuroyadro
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# Создаёт tokenizer.model и tokenized.pt из локальных .txt-файлов
python -m training.prepare_data --input-dir data/raw --output artifacts/demo-data \
  --config configs/demo_1m.json

# Небольшой проверочный прогон. Полное обучение требует намного больше шагов и данных.
python -m training.train \
  --config configs/demo_1m.json \
  --dataset artifacts/demo-data/tokenized.pt \
  --output runs/demo --steps 20 --batch-size 1 --grad-accum 1 \
  --checkpoint-every 10 --device cpu
```

Проверка и продолжение:

```bash
python -m unittest discover -s tests -v
python -m training.train --config configs/demo_1m.json \
  --dataset artifacts/demo-data/tokenized.pt --output runs/demo --steps 1000 \
  --resume auto
```

## Экспорт в GGUF

После обучения нужен каталог с checkpoint и `tokenizer.model`:

```bash
python -m training.export_hf \
  --checkpoint runs/demo/checkpoints/latest.pt \
  --tokenizer artifacts/demo-data/tokenizer.model \
  --output artifacts/neuroyadro-hf

# llama.cpp не вшит в проект: укажите уже клонированную совместимую копию.
python -m training.export_gguf \
  --model-dir artifacts/neuroyadro-hf \
  --llama-cpp-dir /path/to/llama.cpp \
  --output artifacts/neuroyadro-f16.gguf --quantize Q8_0
```

Скрипт экспорта намеренно останавливается при несовпадении параметров или токенизатора: нельзя подменять модель «похожим» GGUF-файлом.

## Структура

| Путь | Назначение |
|---|---|
| `configs/` | единственный источник архитектурной конфигурации модели |
| `data/raw/` | локальные текстовые источники; в Git только маленький demo-корпус |
| `training/` | токенизатор, модель, подготовка данных, обучение и экспорт |
| `tests/` | быстрые офлайн-проверки Stage 0 |
| `app/` | Qt 6/QML desktop MVP; инструкции сборки и точный статус — в [`app/README.md`](app/README.md) |
| `docs/` | данные, воспроизводимость, переход к Qt/llama.cpp приложению |
| `artifacts/`, `runs/` | игнорируемые большие артефакты обучения |

## Ближайший план

1. **Этап 0 (в работе):** прогнать smoke-test после установки зависимостей, затем подготовить открытые лицензированные корпуса и базовый обученный checkpoint.
2. **Этап 1:** Qt 6/QML MVP — локальные чаты SQLite, выбор GGUF, потоковая генерация llama.cpp, статистика, слайдер раздумий, карточки уточнений, суммаризация контекста и анти-повторный фильтр.
3. **Далее:** экран обучения ПК, CI для Windows/Android, затем отдельные генеративные модули изображений, 3D и звука.

Полный план и известные ограничения — в [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
