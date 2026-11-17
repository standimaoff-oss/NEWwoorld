#include "ChatListModel.h"

#include <utility>

ChatListModel::ChatListModel(QObject *parent) : QAbstractListModel(parent) {}

int ChatListModel::rowCount(const QModelIndex &parent) const {
    return parent.isValid() ? 0 : m_conversations.size();
}

QVariant ChatListModel::data(const QModelIndex &index, const int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_conversations.size()) {
        return {};
    }
    const ConversationRecord &item = m_conversations.at(index.row());
    switch (role) {
    case IdRole: return item.id;
    case TitleRole: return item.title;
    case PreviewRole: return item.preview;
    case UpdatedAtRole: return item.updatedAt;
    default: return {};
    }
}

QHash<int, QByteArray> ChatListModel::roleNames() const {
    return {{IdRole, "chatId"}, {TitleRole, "title"}, {PreviewRole, "preview"}, {UpdatedAtRole, "updatedAt"}};
}

void ChatListModel::setConversations(QVector<ConversationRecord> conversations) {
    beginResetModel();
    m_conversations = std::move(conversations);
    endResetModel();
}
