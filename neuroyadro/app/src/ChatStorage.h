#pragma once

#include "ChatTypes.h"

#include <QSqlDatabase>
#include <QString>
#include <QVector>

class ChatStorage final {
public:
    explicit ChatStorage(const QString &databasePath);
    ~ChatStorage();
    ChatStorage(const ChatStorage &) = delete;
    ChatStorage &operator=(const ChatStorage &) = delete;

    void initialize();
    QVector<ConversationRecord> conversations() const;
    ConversationRecord createConversation(const QString &title);
    void renameConversation(qint64 conversationId, const QString &title);
    void deleteConversation(qint64 conversationId);

    QVector<MessageRecord> messages(qint64 conversationId) const;
    MessageRecord addMessage(qint64 conversationId, const QString &role, const QString &content,
                             const GenerationStats &stats = {});
    void updateMessage(qint64 messageId, const QString &content, const GenerationStats &stats);
    void deleteMessage(qint64 messageId);
    void saveClarification(qint64 messageId, const QString &json);

    SummaryRecord summary(qint64 conversationId) const;
    void saveSummary(const SummaryRecord &summary);

private:
    QSqlDatabase m_database;
    QString m_connectionName;

    void execute(const QString &sql) const;
    static void require(bool condition, const QString &description);
};
