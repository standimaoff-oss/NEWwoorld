#pragma once

#include "ChatTypes.h"

#include <QAbstractListModel>
#include <QVector>

class ChatListModel final : public QAbstractListModel {
    Q_OBJECT
public:
    enum Roles { IdRole = Qt::UserRole + 1, TitleRole, PreviewRole, UpdatedAtRole };
    explicit ChatListModel(QObject *parent = nullptr);

    int rowCount(const QModelIndex &parent = {}) const override;
    QVariant data(const QModelIndex &index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;
    void setConversations(QVector<ConversationRecord> conversations);

private:
    QVector<ConversationRecord> m_conversations;
};
