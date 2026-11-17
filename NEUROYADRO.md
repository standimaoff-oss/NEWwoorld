# НейроЯдро — реализация

Техническое задание реализуется в [`neuroyadro/`](neuroyadro/). Сейчас готовы два базовых слоя:

- **Stage 0:** воспроизводимый training pipeline — BPE, LLaMA-совместимое 24.6M ядро, resume-able checkpoints и путь checkpoint → GGUF.
- **Stage 1 desktop MVP:** [`neuroyadro/app/`](neuroyadro/app/) — C++17 / Qt 6 / QML исходники для локальных чатов SQLite, выбора GGUF, in-process llama.cpp streaming, статистики, силы раздумывания, карточек уточнений, локальной суммаризации и anti-repeat.

- [Быстрый запуск и структура](neuroyadro/README.md)
- [Сборка desktop MVP](neuroyadro/app/README.md)
- [Статус, ограничения и план](neuroyadro/docs/IMPLEMENTATION_PLAN.md)
- [Данные и обучение](neuroyadro/docs/DATA_AND_TRAINING.md)
