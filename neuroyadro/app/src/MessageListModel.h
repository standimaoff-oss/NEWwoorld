#pragma once

#include "ChatTypes.h"

#include <QAbstractListModel>
#include <QVector>

class MessageListModel final : public QAbstractListModel {
    Q_OBJECT
public:
    enum Roles {
        IdRole = Qt::UserRole + 1, RoleRole, ContentRole, CreatedAtRole, PromptTokensRole,
        CompletionTokensRole, TokensPerSecondRole, ElapsedSecondsRole, ReasoningStrengthRole,
        StreamingRole, ClarificationRole
    };
    explicit MessageListModel(QObject *parent = nullptr);

    int rowCount(const QModelIndex &parent = {}) const override;
    QVariant data(const QModelIndex &index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    void setMessages(QVector<MessageRecord> messages);
    void appendMessage(const MessageRecord &message);
    void updateGeneratedMessage(qint64 messageId, const QString &content, const GenerationStats &stats, bool streaming);
    void setClarification(qint64 messageId, const QVariantList &clarification);
    void removeMessage(qint64 messageId);

private:
    int indexOf(qint64 messageId) const;
    QVector<MessageRecord> m_messages;
};
