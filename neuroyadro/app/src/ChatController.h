#pragma once

#include "ChatListModel.h"
#include "ChatStorage.h"
#include "ContextPlanner.h"
#include "LlamaWorker.h"
#include "MessageListModel.h"
#include "ReasoningProfile.h"

#include <QAbstractItemModel>
#include <QObject>
#include <QThread>

class ChatController final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QAbstractItemModel *chatModel READ chatModel CONSTANT)
    Q_PROPERTY(QAbstractItemModel *messageModel READ messageModel CONSTANT)
    Q_PROPERTY(qint64 currentChatId READ currentChatId NOTIFY currentChatChanged)
    Q_PROPERTY(QString modelPath READ modelPath NOTIFY modelChanged)
    Q_PROPERTY(QString modelStatus READ modelStatus NOTIFY modelChanged)
    Q_PROPERTY(int modelContextTokens READ modelContextTokens NOTIFY modelChanged)
    Q_PROPERTY(bool generating READ generating NOTIFY generationChanged)
    Q_PROPERTY(int reasoningStrength READ reasoningStrength WRITE setReasoningStrength NOTIFY reasoningChanged)
    Q_PROPERTY(QString reasoningLabel READ reasoningLabel NOTIFY reasoningChanged)
    Q_PROPERTY(QString reasoningDetail READ reasoningDetail NOTIFY reasoningChanged)
    Q_PROPERTY(QString notice READ notice NOTIFY noticeChanged)
public:
    explicit ChatController(const QString &databasePath, QObject *parent = nullptr);
    ~ChatController() override;

    QAbstractItemModel *chatModel();
    QAbstractItemModel *messageModel();
    qint64 currentChatId() const;
    QString modelPath() const;
    QString modelStatus() const;
    int modelContextTokens() const;
    bool generating() const;
    int reasoningStrength() const;
    QString reasoningLabel() const;
    QString reasoningDetail() const;
    QString notice() const;

    Q_INVOKABLE void createChat();
    Q_INVOKABLE void selectChat(qint64 chatId);
    Q_INVOKABLE void renameChat(const QString &title);
    Q_INVOKABLE void deleteCurrentChat();
    Q_INVOKABLE void chooseModel(const QString &path);
    Q_INVOKABLE void setReasoningStrength(int strength);
    Q_INVOKABLE void send(const QString &text);
    Q_INVOKABLE void submitClarification(const QVariantList &questions, const QVariantList &answers);
    Q_INVOKABLE void cancelGeneration();

signals:
    void currentChatChanged();
    void modelChanged();
    void generationChanged();
    void reasoningChanged();
    void noticeChanged();

private slots:
    void onModelReady(const QString &path, int contextTokens);
    void onModelError(const QString &message);
    void onToken(quint64 requestId, const QString &token);
    void onGenerationFinished(quint64 requestId, const GenerationStats &stats, bool canceled);
    void onGenerationError(quint64 requestId, const QString &message);

private:
    enum class RequestKind { None, Summary, Reply };
    ChatStorage m_storage;
    ChatListModel m_chats;
    MessageListModel m_messages;
    QThread m_inferenceThread;
    LlamaWorker *m_worker = nullptr;
    qint64 m_currentChatId = -1;
    QString m_modelPath;
    QString m_modelStatus = QStringLiteral("Модель не выбрана");
    int m_modelContextTokens = 1024;
    bool m_generating = false;
    ReasoningProfile m_reasoning = ReasoningProfile::fromStrength(25);
    QString m_notice;

    RequestKind m_requestKind = RequestKind::None;
    quint64 m_requestId = 0;
    qint64 m_activeMessageId = -1;
    QString m_responseBuffer;
    ContextPlan m_pendingPlan;
    int m_repeatRetry = 0;

    void reloadChats();
    void reloadMessages();
    void setNotice(const QString &notice);
    void startResponse();
    void startSummary(const ContextPlan &plan);
    void startReply(const QString &prompt, qint64 messageId, ReasoningProfile profile);
    void invokeGeneration(quint64 requestId, const QString &prompt, const ReasoningProfile &profile, int maxTokens);
    bool isNearRepeat(const QString &candidate) const;
    QString normalizedNgrams(const QString &text) const;
};
