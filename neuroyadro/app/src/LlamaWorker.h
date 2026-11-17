#pragma once

#include "ChatTypes.h"
#include "ReasoningProfile.h"

#include <QObject>
#include <QString>

#include <atomic>

class LlamaWorker final : public QObject {
    Q_OBJECT
public:
    explicit LlamaWorker(QObject *parent = nullptr);
    ~LlamaWorker() override;

public slots:
    void loadModel(const QString &path, int requestedContextTokens);
    void generate(quint64 requestId, const QString &prompt, const ReasoningProfile &profile, int maxTokens);
    void cancel();
    void unload();

signals:
    void modelReady(const QString &path, int contextTokens);
    void modelError(const QString &message);
    void tokenGenerated(quint64 requestId, const QString &text);
    void generationFinished(quint64 requestId, const GenerationStats &stats, bool canceled);
    void generationError(quint64 requestId, const QString &message);

private:
    std::atomic_bool m_cancel{false};
    void *m_model = nullptr;
    void *m_context = nullptr;
    const void *m_vocab = nullptr;
    int m_contextTokens = 0;

    bool isLoaded() const;
};
