# НейроЯдро — Qt/QML приложение MVP

Приложение — локальный chat-клиент на C++17/Qt 6/QML. Оно хранит историю в SQLite, загружает выбранный GGUF через **встроенный** `llama.cpp`, выдаёт текст потоково, показывает метрики и не создаёт фиктивный ответ, если модель не загружена.

## Что реализовано в этом MVP

- создание, выбор, переименование и удаление локальных чатов;
- SQLite schema с каскадным удалением: conversations, messages, stats, summaries, clarification cards, settings;
- тёмный адаптивный QML интерфейс: боковой список чатов, лента, composer, настройки и слайдер 0–100;
- mapping слайдера на budget/проходы/candidates/разрешение поиска и sampling;
- безопасный JSON parser карточек уточнения из ТЗ; собственный ответ и пропуск;
- локальная суммаризация старой части контекста отдельным невидимым запросом, пока оригинал остаётся в SQLite;
- in-process `llama.cpp` runtime: GGUF load, CPU generation, cancel, top-k/top-p/min-p/temperature/repeat penalty, timings;
- повторный запуск генерации при 72%+ overlap триграмм с прежним ответом (не более двух раз).

Сетевой поиск, self-consistency из нескольких полноценных кандидатов, экран обучения и Android packaging **ещё не реализованы**. Слайдер уже передаёт их будущие policy-параметры, но UI не утверждает, что поиск был выполнен.

## Сборка Linux/macOS

Нужны: Qt 6.5+ с модулями `Core Gui Qml Quick QuickControls2 Sql`, CMake 3.21+, C++17 compiler и checkout `llama.cpp`.

```bash
cd neuroyadro/app
cmake -S . -B build \
  -DNEUROYADRO_LLAMA_CPP_DIR=/absolute/path/to/llama.cpp \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/NeuroYadro
```

Путь к GGUF выбирается в настройках. Для проверки можно использовать demo GGUF, созданный pipeline Stage 0; он технически запускается, но не обучен для полезного диалога.

### Режим без llama.cpp

```bash
cmake -S . -B build -DNEUROYADRO_WITH_LLAMA=OFF
```

UI, SQLite и история собираются, но при выборе модели отобразится точная причина. Это позволяет проверить интерфейс без имитации ответов.

## Windows и Android

Windows: используйте Qt kit MSVC/MinGW, соберите `llama.cpp` тем же compiler/toolchain и после Release выполните `windeployqt` для `NeuroYadro.exe`.

Android: понадобится Qt for Android + NDK и llama.cpp для `arm64-v8a`; обучение в приложении для мобильной цели намеренно не включается. Packaging и CI появятся отдельным этапом — этот sandbox их не содержит.
