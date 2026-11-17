#include "ChatController.h"

#include "ClarificationParser.h"

#include <QFileInfo>
#include <QMetaObject>
#include <QSet>
#include <QUrl>

#include <algorithm>
#include <exception>

namespace {
constexpr int DefaultResponseTokens = 384;
constexpr int SummaryTokens = 180;

QString modelDisplayName(const QString &path) {
    return QFileInfo(path).fileName();
}
}

ChatController::ChatController(const QString &databasePath, QObject *parent)
    : QObject(parent), m_storage(databasePath), m_chats(this), m_messages(this) {
    qRegisterMetaType<GenerationStats>();
    try {
        m_storage.initialize();
        reloadChats();
        if (m_currentChatId < 0) {
            createChat();
        }
    } catch (const std::exception &error) {
        setNotice(QStringLiteral("Не удалось открыть локальную базу чатов: %1").arg(QString::fromStdString(error.what())));
    }

    m_worker = new LlamaWorker;
    m_worker->moveToThread(&m_inferenceThread);
    connect(&m_inferenceThread, &QThread::finished, m_worker, &QObject::deleteLater);
    connect(m_worker, &LlamaWorker::modelReady, this, &ChatController::onModelReady);
    connect(m_worker, &LlamaWorker::modelError, this, &ChatController::onModelError);
    connect(m_worker, &LlamaWorker::tokenGenerated, this, &ChatController::onToken);
    connect(m_worker, &LlamaWorker::generationFinished, this, &ChatController::onGenerationFinished);
    connect(m_worker, &LlamaWorker::generationError, this, &ChatController::onGenerationError);
    m_inferenceThread.start();
}

ChatController::~ChatController() {
    if (m_worker != nullptr) {
        m_worker->cancel(); // atomic flag; safe even while the worker owns llama.cpp
        QMetaObject::invokeMethod(m_worker, &LlamaWorker::unload, Qt::BlockingQueuedConnection);
    }
    m_inferenceThread.quit();
    m_inferenceThread.wait();
}

QAbstractItemModel *ChatController::chatModel() { return &m_chats; }
QAbstractItemModel *ChatController::messageModel() { return &m_messages; }
qint64 ChatController::currentChatId() const { return m_currentChatId; }
QString ChatController::modelPath() const { return m_modelPath; }
QString ChatController::modelStatus() const { return m_modelStatus; }
int ChatController::modelContextTokens() const { return m_modelContextTokens; }
bool ChatController::generating() const { return m_generating; }
int ChatController::reasoningStrength() const { return m_reasoning.strength; }
QString ChatController::reasoningLabel() const { return m_reasoning.label; }
QString ChatController::reasoningDetail() const { return m_reasoning.detail; }
QString ChatController::notice() const { return m_notice; }

void ChatController::setNotice(const QString &notice) {
    if (m_notice == notice) {
        return;
    }
    m_notice = notice;
    emit noticeChanged();
}

void ChatController::reloadChats() {
    m_chats.setConversations(m_storage.conversations());
}

void ChatController::reloadMessages() {
    if (m_currentChatId < 0) {
        m_messages.setMessages({});
        return;
    }
    m_messages.setMessages(m_storage.messages(m_currentChatId));
}

void ChatController::createChat() {
    if (m_generating) {
        setNotice(QStringLiteral("Дождитесь завершения текущей генерации или отмените её."));
        return;
    }
    try {
        const ConversationRecord record = m_storage.createConversation(QStringLiteral("Новый чат"));
        m_currentChatId = record.id;
        reloadChats();
        reloadMessages();
        emit currentChatChanged();
        setNotice({});
    } catch (const std::exception &error) {
        setNotice(QStringLiteral("Не удалось создать чат: %1").arg(QString::fromStdString(error.what())));
    }
}

void ChatController::selectChat(const qint64 chatId) {
    if (chatId < 0 || chatId == m_currentChatId) {
        return;
    }
    if (m_generating) {
        setNotice(QStringLiteral("Нельзя переключить чат во время генерации. Сначала отмените её."));
        return;
    }
    m_currentChatId = chatId;
    try {
        reloadMessages();
        emit currentChatChanged();
        setNotice({});
    } catch (const std::exception &error) {
        setNotice(QStringLiteral("Не удалось открыть чат: %1").arg(QString::fromStdString(error.what())));
    }
}

void ChatController::renameChat(const QString &title) {
    if (m_currentChatId < 0 || m_generating) {
        return;
    }
    try {
        m_storage.renameConversation(m_currentChatId, title);
        reloadChats();
    } catch (const std::exception &error) {
        setNotice(QStringLiteral("Не удалось переименовать чат: %1").arg(QString::fromStdString(error.what())));
    }
}

void ChatController::deleteCurrentChat() {
    if (m_currentChatId < 0 || m_generating) {
        return;
    }
    try {
        m_storage.deleteConversation(m_currentChatId);
        m_currentChatId = -1;
        reloadChats();
        createChat();
    } catch (const std::exception &error) {
        setNotice(QStringLiteral("Не удалось удалить чат: %1").arg(QString::fromStdString(error.what())));
    }
}

void ChatController::chooseModel(const QString &path) {
    if (path.isEmpty() || m_generating) {
        return;
    }
    const QUrl candidate(path);
    const QString localPath = candidate.isLocalFile() ? candidate.toLocalFile() : path;
    m_modelStatus = QStringLiteral("Загрузка модели…");
    m_modelPath.clear();
    emit modelChanged();
    setNotice({});
    QMetaObject::invokeMethod(m_worker, [worker = m_worker, localPath, context = m_modelContextTokens] {
        worker->loadModel(localPath, context);
    }, Qt::QueuedConnection);
}

void ChatController::setReasoningStrength(const int strength) {
    const ReasoningProfile updated = ReasoningProfile::fromStrength(strength);
    if (updated.strength == m_reasoning.strength) {
        return;
    }
    m_reasoning = updated;
    emit reasoningChanged();
}

void ChatController::send(const QString &text) {
    const QString content = text.trimmed();
    if (content.isEmpty() || m_generating) {
        return;
    }
    if (m_currentChatId < 0) {
        createChat();
    }
    if (m_modelPath.isEmpty()) {
        setNotice(QStringLiteral("Ответ не создан: выберите совместимый локальный файл GGUF."));
        return;
    }
    try {
        const MessageRecord message = m_storage.addMessage(m_currentChatId, QStringLiteral("user"), content);
        m_messages.appendMessage(message);
        reloadChats();
        startResponse();
    } catch (const std::exception &error) {
        setNotice(QStringLiteral("Не удалось сохранить сообщение: %1").arg(QString::fromStdString(error.what())));
    }
}

void ChatController::submitClarification(const QVariantList &questions, const QVariantList &answers) {
    if (m_generating || questions.isEmpty()) {
        return;
    }
    send(ClarificationParser::serializeAnswers(questions, answers));
}

void ChatController::cancelGeneration() {
    if (!m_generating) {
        return;
    }
    setNotice(QStringLiteral("Останавливаю генерацию…"));
    m_worker->cancel();
}

void ChatController::startResponse() {
    try {
        QVector<MessageRecord> history = m_storage.messages(m_currentChatId);
        history.erase(std::remove_if(history.begin(), history.end(), [this](const MessageRecord &message) {
            return message.id == m_activeMessageId && message.role == QStringLiteral("assistant") && message.content.isEmpty();
        }), history.end());
        const ContextPlan plan = ContextPlanner::plan(history, m_storage.summary(m_currentChatId),
                                                      m_modelContextTokens, DefaultResponseTokens);
        if (!plan.fits) {
            setNotice(QStringLiteral("Последнее сообщение не помещается в контекст модели даже после суммаризации."));
            return;
        }
        if (!plan.messagesToSummarize.isEmpty()) {
            startSummary(plan);
            return;
        }
        GenerationStats initialStats;
        initialStats.reasoningStrength = m_reasoning.strength;
        MessageRecord placeholder = m_storage.addMessage(m_currentChatId, QStringLiteral("assistant"), {}, initialStats);
        placeholder.streaming = true;
        m_messages.appendMessage(placeholder);
        m_repeatRetry = 0;
        startReply(plan.prompt, placeholder.id, m_reasoning);
    } catch (const std::exception &error) {
        setNotice(QStringLiteral("Не удалось подготовить контекст: %1").arg(QString::fromStdString(error.what())));
    }
}

void ChatController::startSummary(const ContextPlan &plan) {
    m_pendingPlan = plan;
    m_requestKind = RequestKind::Summary;
    m_responseBuffer.clear();
    m_generating = true;
    emit generationChanged();
    setNotice(QStringLiteral("Суммирую раннюю часть диалога локальной моделью…"));
    ReasoningProfile summaryProfile = m_reasoning;
    summaryProfile.sampling.temperature = 0.20F;
    summaryProfile.candidates = 1;
    summaryProfile.internalPasses = 0;
    invokeGeneration(++m_requestId, plan.summaryPrompt, summaryProfile, SummaryTokens);
}

void ChatController::startReply(const QString &prompt, const qint64 messageId, ReasoningProfile profile) {
    m_requestKind = RequestKind::Reply;
    m_activeMessageId = messageId;
    m_responseBuffer.clear();
    m_generating = true;
    emit generationChanged();
    setNotice(QStringLiteral("НейроЯдро печатает…"));
    invokeGeneration(++m_requestId, prompt, profile, DefaultResponseTokens);
}

void ChatController::invokeGeneration(const quint64 requestId, const QString &prompt, const ReasoningProfile &profile,
                                      const int maxTokens) {
    QMetaObject::invokeMethod(m_worker, [worker = m_worker, requestId, prompt, profile, maxTokens] {
        worker->generate(requestId, prompt, profile, maxTokens);
    }, Qt::QueuedConnection);
}

void ChatController::onModelReady(const QString &path, const int contextTokens) {
    m_modelPath = path;
    m_modelContextTokens = contextTokens;
    m_modelStatus = QStringLiteral("Готова · %1 · %2 токенов контекста").arg(modelDisplayName(path)).arg(contextTokens);
    emit modelChanged();
    setNotice({});
}

void ChatController::onModelError(const QString &message) {
    m_modelPath.clear();
    m_modelStatus = QStringLiteral("Модель не готова");
    emit modelChanged();
    setNotice(message);
}

void ChatController::onToken(const quint64 requestId, const QString &token) {
    if (requestId != m_requestId) {
        return;
    }
    m_responseBuffer.append(token);
    if (m_requestKind == RequestKind::Reply) {
        GenerationStats partial;
        partial.reasoningStrength = m_reasoning.strength;
        m_messages.updateGeneratedMessage(m_activeMessageId, m_responseBuffer, partial, true);
    }
}

QString ChatController::normalizedNgrams(const QString &text) const {
    QString normalized;
    normalized.reserve(text.size());
    for (const QChar character : text.toCaseFolded()) {
        normalized.append(character.isLetterOrNumber() ? character : QLatin1Char(' '));
    }
    return normalized.simplified();
}

bool ChatController::isNearRepeat(const QString &candidate) const {
    const QString normalizedCandidate = normalizedNgrams(candidate);
    const QStringList candidateWords = normalizedCandidate.split(QLatin1Char(' '), Qt::SkipEmptyParts);
    if (candidateWords.size() < 6) {
        return false;
    }
    QSet<QString> candidateTrigrams;
    for (qsizetype index = 0; index + 2 < candidateWords.size(); ++index) {
        candidateTrigrams.insert(candidateWords.mid(index, 3).join(QLatin1Char(' ')));
    }
    for (const MessageRecord &message : m_storage.messages(m_currentChatId)) {
        if (message.role != QStringLiteral("assistant") || message.id == m_activeMessageId || message.content.isEmpty()) {
            continue;
        }
        const QString normalizedPrevious = normalizedNgrams(message.content);
        if (normalizedPrevious == normalizedCandidate) {
            return true;
        }
        const QStringList previousWords = normalizedPrevious.split(QLatin1Char(' '), Qt::SkipEmptyParts);
        QSet<QString> previousTrigrams;
        for (qsizetype index = 0; index + 2 < previousWords.size(); ++index) {
            previousTrigrams.insert(previousWords.mid(index, 3).join(QLatin1Char(' ')));
        }
        int overlap = 0;
        for (const QString &gram : candidateTrigrams) {
            overlap += previousTrigrams.contains(gram) ? 1 : 0;
        }
        if (overlap * 100 >= candidateTrigrams.size() * 72) {
            return true;
        }
    }
    return false;
}

void ChatController::onGenerationFinished(const quint64 requestId, const GenerationStats &stats, const bool canceled) {
    if (requestId != m_requestId) {
        return;
    }
    m_generating = false;
    emit generationChanged();

    if (m_requestKind == RequestKind::Summary) {
        m_requestKind = RequestKind::None;
        if (canceled || m_responseBuffer.trimmed().isEmpty()) {
            setNotice(QStringLiteral("Суммаризация отменена; исходные сообщения сохранены."));
            return;
        }
        try {
            SummaryRecord summary;
            summary.conversationId = m_currentChatId;
            summary.throughMessageId = m_pendingPlan.summaryThroughMessageId;
            summary.content = m_responseBuffer.trimmed();
            summary.tokenEstimate = ContextPlanner::estimateTokens(summary.content);
            m_storage.saveSummary(summary);
            setNotice({});
            startResponse();
        } catch (const std::exception &error) {
            setNotice(QStringLiteral("Не удалось сохранить сводку: %1").arg(QString::fromStdString(error.what())));
        }
        return;
    }
    if (m_requestKind != RequestKind::Reply) {
        return;
    }
    m_requestKind = RequestKind::None;
    try {
        if (canceled && m_responseBuffer.trimmed().isEmpty()) {
            m_storage.deleteMessage(m_activeMessageId);
            m_messages.removeMessage(m_activeMessageId);
            setNotice(QStringLiteral("Генерация отменена."));
            return;
        }
        if (!canceled && isNearRepeat(m_responseBuffer) && m_repeatRetry < 2) {
            ++m_repeatRetry;
            ReasoningProfile retryProfile = m_reasoning;
            retryProfile.sampling.temperature = qMin(1.10F, retryProfile.sampling.temperature + 0.12F);
            retryProfile.sampling.repetitionPenalty += 0.05F;
            m_messages.updateGeneratedMessage(m_activeMessageId, {}, {}, true);
            QVector<MessageRecord> history = m_storage.messages(m_currentChatId);
            history.erase(std::remove_if(history.begin(), history.end(), [this](const MessageRecord &message) {
                return message.id == m_activeMessageId && message.content.isEmpty();
            }), history.end());
            const ContextPlan plan = ContextPlanner::plan(history, m_storage.summary(m_currentChatId),
                                                          m_modelContextTokens, DefaultResponseTokens);
            if (plan.fits && plan.messagesToSummarize.isEmpty()) {
                setNotice(QStringLiteral("Повтор обнаружен: перегенерирую ответ с более разнообразным sampling…"));
                startReply(plan.prompt, m_activeMessageId, retryProfile);
                return;
            }
        }
        m_storage.updateMessage(m_activeMessageId, m_responseBuffer, stats);
        m_messages.updateGeneratedMessage(m_activeMessageId, m_responseBuffer, stats, false);
        const QVariantList clarification = ClarificationParser::parse(m_responseBuffer);
        if (!clarification.isEmpty()) {
            m_storage.saveClarification(m_activeMessageId, m_responseBuffer.trimmed());
            m_messages.setClarification(m_activeMessageId, clarification);
        }
        reloadChats();
        setNotice(canceled ? QStringLiteral("Генерация остановлена пользователем.") : QString());
    } catch (const std::exception &error) {
        setNotice(QStringLiteral("Не удалось сохранить ответ: %1").arg(QString::fromStdString(error.what())));
    }
}

void ChatController::onGenerationError(const quint64 requestId, const QString &message) {
    if (requestId != m_requestId) {
        return;
    }
    const RequestKind failedKind = m_requestKind;
    m_requestKind = RequestKind::None;
    m_generating = false;
    emit generationChanged();
    if (failedKind == RequestKind::Reply && m_activeMessageId >= 0) {
        try {
            m_storage.deleteMessage(m_activeMessageId);
            m_messages.removeMessage(m_activeMessageId);
        } catch (const std::exception &) {
            // Original user input remains safe even if cleanup itself cannot reach the database.
        }
    }
    setNotice(message);
}
