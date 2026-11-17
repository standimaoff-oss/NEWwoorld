#include "MessageListModel.h"

#include <utility>

MessageListModel::MessageListModel(QObject *parent) : QAbstractListModel(parent) {}

int MessageListModel::rowCount(const QModelIndex &parent) const {
    return parent.isValid() ? 0 : m_messages.size();
}

QVariant MessageListModel::data(const QModelIndex &index, const int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_messages.size()) {
        return {};
    }
    const MessageRecord &item = m_messages.at(index.row());
    switch (role) {
    case IdRole: return item.id;
    case RoleRole: return item.role;
    case ContentRole: return item.content;
    case CreatedAtRole: return item.createdAt;
    case PromptTokensRole: return item.stats.promptTokens;
    case CompletionTokensRole: return item.stats.completionTokens;
    case TokensPerSecondRole: return item.stats.tokensPerSecond;
    case ElapsedSecondsRole: return item.stats.elapsedSeconds;
    case ReasoningStrengthRole: return item.stats.reasoningStrength;
    case StreamingRole: return item.streaming;
    case ClarificationRole: return item.clarification;
    default: return {};
    }
}

QHash<int, QByteArray> MessageListModel::roleNames() const {
    return {
        {IdRole, "messageId"}, {RoleRole, "sender"}, {ContentRole, "content"}, {CreatedAtRole, "createdAt"},
        {PromptTokensRole, "promptTokens"}, {CompletionTokensRole, "completionTokens"},
        {TokensPerSecondRole, "tokensPerSecond"}, {ElapsedSecondsRole, "elapsedSeconds"},
        {ReasoningStrengthRole, "reasoningStrength"}, {StreamingRole, "streaming"},
        {ClarificationRole, "clarification"}
    };
}

void MessageListModel::setMessages(QVector<MessageRecord> messages) {
    beginResetModel();
    m_messages = std::move(messages);
    endResetModel();
}

void MessageListModel::appendMessage(const MessageRecord &message) {
    const int row = m_messages.size();
    beginInsertRows({}, row, row);
    m_messages.append(message);
    endInsertRows();
}

int MessageListModel::indexOf(const qint64 messageId) const {
    for (qsizetype index = 0; index < m_messages.size(); ++index) {
        if (m_messages.at(index).id == messageId) {
            return static_cast<int>(index);
        }
    }
    return -1;
}

void MessageListModel::updateGeneratedMessage(const qint64 messageId, const QString &content,
                                              const GenerationStats &stats, const bool streaming) {
    const int row = indexOf(messageId);
    if (row < 0) {
        return;
    }
    MessageRecord &item = m_messages[row];
    item.content = content;
    item.stats = stats;
    item.streaming = streaming;
    const QModelIndex modelIndex = index(row);
    emit dataChanged(modelIndex, modelIndex, {ContentRole, PromptTokensRole, CompletionTokensRole,
                     TokensPerSecondRole, ElapsedSecondsRole, ReasoningStrengthRole, StreamingRole});
}

void MessageListModel::setClarification(const qint64 messageId, const QVariantList &clarification) {
    const int row = indexOf(messageId);
    if (row < 0) {
        return;
    }
    m_messages[row].clarification = clarification;
    const QModelIndex modelIndex = index(row);
    emit dataChanged(modelIndex, modelIndex, {ClarificationRole});
}

void MessageListModel::removeMessage(const qint64 messageId) {
    const int row = indexOf(messageId);
    if (row < 0) {
        return;
    }
    beginRemoveRows({}, row, row);
    m_messages.removeAt(row);
    endRemoveRows();
}
