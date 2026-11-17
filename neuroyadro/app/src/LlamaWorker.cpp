#include "LlamaWorker.h"

#include <QByteArray>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QThread>
#include <QVector>
#include <QtGlobal>

#ifdef NEUROYADRO_WITH_LLAMA
#include <llama.h>

#include <algorithm>
#include <climits>
#include <mutex>
#endif

LlamaWorker::LlamaWorker(QObject *parent) : QObject(parent) {}

LlamaWorker::~LlamaWorker() {
    unload();
}

bool LlamaWorker::isLoaded() const {
    return m_model != nullptr && m_context != nullptr && m_vocab != nullptr;
}

void LlamaWorker::unload() {
#ifdef NEUROYADRO_WITH_LLAMA
    if (m_context != nullptr) {
        llama_free(static_cast<llama_context *>(m_context));
        m_context = nullptr;
    }
    if (m_model != nullptr) {
        llama_model_free(static_cast<llama_model *>(m_model));
        m_model = nullptr;
    }
#endif
    m_vocab = nullptr;
    m_contextTokens = 0;
    m_cancel.store(false);
}

void LlamaWorker::loadModel(const QString &path, const int requestedContextTokens) {
    unload();
    if (!QFileInfo::exists(path)) {
        emit modelError(QStringLiteral("Файл GGUF не найден."));
        return;
    }
#ifndef NEUROYADRO_WITH_LLAMA
    Q_UNUSED(requestedContextTokens)
    emit modelError(QStringLiteral("Приложение собрано без llama.cpp. Укажите NEUROYADRO_LLAMA_CPP_DIR при сборке."));
#else
    static std::once_flag backendOnce;
    std::call_once(backendOnce, [] { llama_backend_init(); });

    const QByteArray nativePath = QFile::encodeName(path);
    llama_model_params modelParams = llama_model_default_params();
    llama_model *model = llama_model_load_from_file(nativePath.constData(), modelParams);
    if (model == nullptr) {
        emit modelError(QStringLiteral("Не удалось загрузить GGUF: проверьте совместимость файла с llama.cpp."));
        return;
    }
    const int trainedContext = llama_model_n_ctx_train(model);
    llama_context_params contextParams = llama_context_default_params();
    contextParams.n_ctx = static_cast<uint32_t>(qMax(128, trainedContext > 0
        ? qMin(requestedContextTokens, trainedContext) : requestedContextTokens));
    contextParams.n_batch = qMin(contextParams.n_ctx, 512U);
    contextParams.n_ubatch = contextParams.n_batch;
    contextParams.n_threads = qMax(1, QThread::idealThreadCount() - 1);
    contextParams.n_threads_batch = contextParams.n_threads;
    contextParams.abort_callback = [](void *data) -> bool {
        return static_cast<std::atomic_bool *>(data)->load();
    };
    contextParams.abort_callback_data = &m_cancel;

    llama_context *context = llama_init_from_model(model, contextParams);
    if (context == nullptr) {
        llama_model_free(model);
        emit modelError(QStringLiteral("Не удалось создать контекст llama.cpp: недостаточно памяти или неверные параметры."));
        return;
    }
    m_model = model;
    m_context = context;
    m_vocab = llama_model_get_vocab(model);
    m_contextTokens = static_cast<int>(llama_n_ctx(context));
    emit modelReady(path, m_contextTokens);
#endif
}

void LlamaWorker::cancel() {
    m_cancel.store(true);
}

void LlamaWorker::generate(const quint64 requestId, const QString &prompt, const ReasoningProfile &profile,
                           const int maxTokens) {
#ifndef NEUROYADRO_WITH_LLAMA
    Q_UNUSED(prompt)
    Q_UNUSED(profile)
    Q_UNUSED(maxTokens)
    emit generationError(requestId, QStringLiteral("Локальный runtime llama.cpp не подключён к этой сборке."));
#else
    if (!isLoaded()) {
        emit generationError(requestId, QStringLiteral("Сначала выберите и загрузите файл GGUF."));
        return;
    }
    m_cancel.store(false);
    auto *context = static_cast<llama_context *>(m_context);
    const auto *vocab = static_cast<const llama_vocab *>(m_vocab);
    const QByteArray utf8Prompt = prompt.toUtf8();
    int tokenCount = llama_tokenize(vocab, utf8Prompt.constData(), utf8Prompt.size(), nullptr, 0, true, false);
    if (tokenCount == INT32_MIN) {
        emit generationError(requestId, QStringLiteral("Запрос слишком велик для токенизатора модели."));
        return;
    }
    if (tokenCount < 0) {
        tokenCount = -tokenCount;
    }
    QVector<llama_token> promptTokens(tokenCount);
    const int tokenized = llama_tokenize(vocab, utf8Prompt.constData(), utf8Prompt.size(), promptTokens.data(),
                                         promptTokens.size(), true, false);
    if (tokenized < 1) {
        emit generationError(requestId, QStringLiteral("Не удалось токенизировать запрос."));
        return;
    }
    promptTokens.resize(tokenized);
    const int promptTokenCount = static_cast<int>(promptTokens.size());
    const int limit = qMax(1, qMin(maxTokens, m_contextTokens - promptTokenCount - 1));
    if (limit < 1 || promptTokenCount >= m_contextTokens - 1) {
        emit generationError(requestId, QStringLiteral("Диалог не помещается в контекст модели. Уменьшите сообщение или дождитесь суммаризации."));
        return;
    }

    llama_memory_clear(llama_get_memory(context), true);
    llama_batch promptBatch = llama_batch_init(promptTokens.size(), 0, 1);
    for (int index = 0; index < promptTokens.size(); ++index) {
        promptBatch.token[index] = promptTokens.at(index);
        promptBatch.pos[index] = index;
        promptBatch.n_seq_id[index] = 1;
        promptBatch.seq_id[index][0] = 0;
        promptBatch.logits[index] = index == promptTokens.size() - 1;
    }
    const int decodeResult = llama_decode(context, promptBatch);
    llama_batch_free(promptBatch);
    if (decodeResult != 0) {
        emit generationError(requestId, QStringLiteral("llama.cpp не смог обработать запрос (%1).").arg(decodeResult));
        return;
    }

    llama_sampler_chain_params chainParams = llama_sampler_chain_default_params();
    llama_sampler *sampler = llama_sampler_chain_init(chainParams);
    llama_sampler_chain_add(sampler, llama_sampler_init_penalties(llama_vocab_n_tokens(vocab), profile.sampling.repeatWindow,
        profile.sampling.repetitionPenalty, 0.0F, 0.0F));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_k(40));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(profile.sampling.topP, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_min_p(profile.sampling.minP, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(profile.sampling.temperature));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));
    for (const llama_token token : promptTokens) {
        llama_sampler_accept(sampler, token);
    }

    GenerationStats stats;
    stats.promptTokens = promptTokenCount;
    stats.reasoningStrength = profile.strength;
    QElapsedTimer timer;
    timer.start();
    int position = promptTokenCount;
    for (int produced = 0; produced < limit && !m_cancel.load(); ++produced) {
        const llama_token next = llama_sampler_sample(sampler, context, -1);
        if (llama_vocab_is_eog(vocab, next)) {
            break;
        }
        int pieceLength = llama_token_to_piece(vocab, next, nullptr, 0, 0, false);
        if (pieceLength < 0) {
            pieceLength = -pieceLength;
        }
        QByteArray piece(pieceLength, Qt::Uninitialized);
        const int written = llama_token_to_piece(vocab, next, piece.data(), piece.size(), 0, false);
        if (written < 0) {
            llama_sampler_free(sampler);
            emit generationError(requestId, QStringLiteral("Не удалось декодировать токен модели."));
            return;
        }
        piece.resize(written);
        emit tokenGenerated(requestId, QString::fromUtf8(piece));
        ++stats.completionTokens;
        llama_sampler_accept(sampler, next);

        llama_batch nextBatch = llama_batch_init(1, 0, 1);
        nextBatch.token[0] = next;
        nextBatch.pos[0] = position++;
        nextBatch.n_seq_id[0] = 1;
        nextBatch.seq_id[0][0] = 0;
        nextBatch.logits[0] = true;
        const int nextDecodeResult = llama_decode(context, nextBatch);
        llama_batch_free(nextBatch);
        if (nextDecodeResult != 0) {
            llama_sampler_free(sampler);
            emit generationError(requestId, QStringLiteral("Генерация остановлена llama.cpp (%1).").arg(nextDecodeResult));
            return;
        }
    }
    llama_sampler_free(sampler);
    stats.elapsedSeconds = static_cast<double>(timer.elapsed()) / 1000.0;
    stats.tokensPerSecond = stats.completionTokens / qMax(0.001, stats.elapsedSeconds);
    emit generationFinished(requestId, stats, m_cancel.load());
#endif
}
