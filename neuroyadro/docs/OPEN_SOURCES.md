# Открытые источники для русской базы

Выбран режим «подобрать открытые источники». Это **не** означает, что любой текст из интернета можно скачивать и обучать: в проект добавлены только метаданные источников, а не их содержимое. Полный список с зафиксированными commit — [`data/sources/open_sources.json`](../data/sources/open_sources.json).

## Первый кандидат для масштабного CPU/GPU-прогона

`maxoodf/russian_news_corpus` имеет репозиторную лицензию Apache-2.0 и публикует размеченный как открытый корпус новостных текстов. Его README указывает примерно 1,5 млн статей и 360 млн слов, но тексты уже стеммированы. Это хороший объём для начального языкового обучения и плохая единственная основа для грамотного свободного русского: падежи, окончания и часть пунктуации в нём утрачены.

Поэтому он будет использоваться только как **первый, явно отмеченный компонент смеси**, не как доказательство качества итоговой модели. Перед релизом весов нужна дополнительная проверка прав исходных публикаций и добавление не-стеммированных источников с ясной лицензией.

## Получение и обработка

```bash
cd neuroyadro

# Явно подтверждает Apache-2.0 и возможную большую загрузку.
python -m training.acquire_sources \
  --source maxoodf-russian-news-2017 \
  --destination data/external/maxoodf-russian-news-2017 \
  --accept-license Apache-2.0 --allow-large-download

# Полный запуск: limit-documents 0. Для проверки можно начать с 100000.
python -m training.extract_maxoodf_news \
  --source-dir data/external/maxoodf-russian-news-2017 \
  --output data/raw/maxoodf-news/news.txt --limit-documents 0

# Shards исключают загрузку всех токенов в RAM.
python -m training.prepare_data \
  --input-dir data/raw/maxoodf-news --output artifacts/news-v1 \
  --config configs/neuroyadro_25m.json \
  --storage shards --shard-tokens 10000000

python -m training.train \
  --config configs/neuroyadro_25m.json \
  --dataset artifacts/news-v1/tokenized.json \
  --output runs/news-v1 --steps 200000 \
  --batch-size 1 --grad-accum 8 --checkpoint-every 250 --resume auto
```

`data/external/` и все импортированные файлы в `data/raw/`, кроме маленького demo, игнорируются Git. Provenance JSON фиксирует commit, лицензию, хеши и фильтры. При старте обучения хешируется каждый token shard: возобновление не примет изменённый набор.

## Проверенный ограниченный health-check

В этой ветке pipeline был проверен на первых 100 000 принятых документах pinned corpus: **167 872 398** символов, **37 492 424** токена, 4 memory-mapped uint16-shard. 16 строк с некорректными UTF-8 байтами были исключены; SHA-256 извлечённого текста: `d2bd9df946b3a1f6acebbd16139fd99a8bbc67012a321ae7b5de2871224a0d90`. Реальная 25M-модель выполнила шаг 1 и корректно возобновилась до шага 2 из checkpoint. Это проверка ingestion/resume, **не** качественное обучение и не релиз модели.

## Другие кандидаты

- `natasha/nerus` — MIT-репозиторий с описанием крупного новостного корпуса, но сами данные лежат за пределами GitHub. Его acquisition намеренно manual: сначала нужно перепроверить условия data-host и прав на статьи.
- `RussianNLP/RuCoLA` (Apache-2.0) — небольшой corpus для оценки приемлемости предложений; подходит для evaluation/узкого дообучения, а не pretraining.
- `Koziev/NLP_Datasets` (CC0-1.0) — набор разных NLP-задач. Отдельные подмножества можно отбирать для дальнейшего instruction-tuning после проверки provenance каждого поднабора.

## Реалистичный бюджет

360M слов — заметный первый компонент, но недостаточный, чтобы обещать «очень сильную» универсальную модель. 25M-модель на CPU с двумя ядрами будет обучаться очень долго; здесь корректно сделать ingestion, короткий health-check и checkpoints. Длительный запуск нужно продолжать на ПК с GPU или выделенном сервере, сохраняя тот же `runs/news-v1`.
