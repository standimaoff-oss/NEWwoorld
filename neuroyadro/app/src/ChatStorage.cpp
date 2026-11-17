#include "ChatStorage.h"
#include "ClarificationParser.h"

#include <QDir>
#include <QFileInfo>
#include <QSqlError>
#include <QSqlQuery>
#include <QUuid>

#include <stdexcept>

namespace {
qint64 nowUtcMillis() {
    return QDateTime::currentDateTimeUtc().toMSecsSinceEpoch();
}

QDateTime fromUtcMillis(const QVariant &value) {
    return QDateTime::fromMSecsSinceEpoch(value.toLongLong(), Qt::UTC).toLocalTime();
}

QString normalizedTitle(const QString &candidate) {
    const QString title = candidate.simplified();
    return title.isEmpty() ? QStringLiteral("Новый чат") : title.left(120);
}
}

ChatStorage::ChatStorage(const QString &databasePath)
    : m_connectionName(QStringLiteral("neuroyadro-storage-%1").arg(QUuid::createUuid().toString(QUuid::Id128))) {
    const QFileInfo fileInfo(databasePath);
    QDir().mkpath(fileInfo.absolutePath());
    m_database = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), m_connectionName);
    m_database.setDatabaseName(databasePath);
}

ChatStorage::~ChatStorage() {
    if (m_database.isOpen()) {
        m_database.close();
    }
    m_database = {};
    QSqlDatabase::removeDatabase(m_connectionName);
}

void ChatStorage::require(const bool condition, const QString &description) {
    if (!condition) {
        throw std::runtime_error(description.toStdString());
    }
}

void ChatStorage::execute(const QString &sql) const {
    QSqlQuery query(m_database);
    require(query.exec(sql), query.lastError().text());
}

void ChatStorage::initialize() {
    require(m_database.open(), m_database.lastError().text());
    execute(QStringLiteral("PRAGMA foreign_keys = ON"));
    execute(QStringLiteral("PRAGMA journal_mode = WAL"));
    execute(QStringLiteral("PRAGMA busy_timeout = 5000"));
    execute(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS conversations ("
        "id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"));
    execute(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS messages ("
        "id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,"
        "role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, created_at INTEGER NOT NULL,"
        "prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,"
        "tokens_per_second REAL NOT NULL DEFAULT 0, generation_seconds REAL NOT NULL DEFAULT 0,"
        "reasoning_strength INTEGER NOT NULL DEFAULT 0)"));
    execute(QStringLiteral("CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, id)"));
    execute(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS summaries ("
        "conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,"
        "through_message_id INTEGER NOT NULL, content TEXT NOT NULL, token_estimate INTEGER NOT NULL, updated_at INTEGER NOT NULL)"));
    execute(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS clarification_cards ("
        "message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, payload TEXT NOT NULL, answered_at INTEGER)"));
    execute(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"));
}

QVector<ConversationRecord> ChatStorage::conversations() const {
    QSqlQuery query(m_database);
    require(query.exec(QStringLiteral(
        "SELECT c.id, c.title, c.created_at, c.updated_at, "
        "COALESCE((SELECT m.content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1), '') "
        "FROM conversations c ORDER BY c.updated_at DESC, c.id DESC")), query.lastError().text());
    QVector<ConversationRecord> result;
    while (query.next()) {
        ConversationRecord item;
        item.id = query.value(0).toLongLong();
        item.title = query.value(1).toString();
        item.createdAt = fromUtcMillis(query.value(2));
        item.updatedAt = fromUtcMillis(query.value(3));
        item.preview = query.value(4).toString().simplified().left(110);
        result.append(item);
    }
    return result;
}

ConversationRecord ChatStorage::createConversation(const QString &title) {
    const qint64 timestamp = nowUtcMillis();
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral("INSERT INTO conversations(title, created_at, updated_at) VALUES (?, ?, ?)"));
    query.addBindValue(normalizedTitle(title));
    query.addBindValue(timestamp);
    query.addBindValue(timestamp);
    require(query.exec(), query.lastError().text());
    ConversationRecord record;
    record.id = query.lastInsertId().toLongLong();
    record.title = normalizedTitle(title);
    record.createdAt = QDateTime::fromMSecsSinceEpoch(timestamp, Qt::UTC).toLocalTime();
    record.updatedAt = record.createdAt;
    return record;
}

void ChatStorage::renameConversation(const qint64 conversationId, const QString &title) {
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral("UPDATE conversations SET title=?, updated_at=? WHERE id=?"));
    query.addBindValue(normalizedTitle(title));
    query.addBindValue(nowUtcMillis());
    query.addBindValue(conversationId);
    require(query.exec(), query.lastError().text());
    require(query.numRowsAffected() == 1, QStringLiteral("chat not found"));
}

void ChatStorage::deleteConversation(const qint64 conversationId) {
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral("DELETE FROM conversations WHERE id=?"));
    query.addBindValue(conversationId);
    require(query.exec(), query.lastError().text());
}

QVector<MessageRecord> ChatStorage::messages(const qint64 conversationId) const {
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral(
        "SELECT m.id,m.conversation_id,m.role,m.content,m.created_at,m.prompt_tokens,m.completion_tokens,"
        "m.tokens_per_second,m.generation_seconds,m.reasoning_strength,COALESCE(cc.payload,'') "
        "FROM messages m LEFT JOIN clarification_cards cc ON cc.message_id=m.id "
        "WHERE m.conversation_id=? ORDER BY m.id ASC"));
    query.addBindValue(conversationId);
    require(query.exec(), query.lastError().text());
    QVector<MessageRecord> result;
    while (query.next()) {
        MessageRecord item;
        item.id = query.value(0).toLongLong();
        item.conversationId = query.value(1).toLongLong();
        item.role = query.value(2).toString();
        item.content = query.value(3).toString();
        item.createdAt = fromUtcMillis(query.value(4));
        item.stats.promptTokens = query.value(5).toInt();
        item.stats.completionTokens = query.value(6).toInt();
        item.stats.tokensPerSecond = query.value(7).toDouble();
        item.stats.elapsedSeconds = query.value(8).toDouble();
        item.stats.reasoningStrength = query.value(9).toInt();
        item.clarification = ClarificationParser::parse(query.value(10).toString());
        result.append(item);
    }
    return result;
}

MessageRecord ChatStorage::addMessage(const qint64 conversationId, const QString &role, const QString &content,
                                      const GenerationStats &stats) {
    require(role == QStringLiteral("user") || role == QStringLiteral("assistant") || role == QStringLiteral("system"),
            QStringLiteral("invalid message role"));
    const qint64 timestamp = nowUtcMillis();
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral(
        "INSERT INTO messages(conversation_id,role,content,created_at,prompt_tokens,completion_tokens,tokens_per_second,"
        "generation_seconds,reasoning_strength) VALUES (?,?,?,?,?,?,?,?,?)"));
    query.addBindValue(conversationId);
    query.addBindValue(role);
    query.addBindValue(content);
    query.addBindValue(timestamp);
    query.addBindValue(stats.promptTokens);
    query.addBindValue(stats.completionTokens);
    query.addBindValue(stats.tokensPerSecond);
    query.addBindValue(stats.elapsedSeconds);
    query.addBindValue(stats.reasoningStrength);
    require(query.exec(), query.lastError().text());

    QSqlQuery touch(m_database);
    touch.prepare(QStringLiteral("UPDATE conversations SET updated_at=? WHERE id=?"));
    touch.addBindValue(timestamp);
    touch.addBindValue(conversationId);
    require(touch.exec(), touch.lastError().text());

    MessageRecord record;
    record.id = query.lastInsertId().toLongLong();
    record.conversationId = conversationId;
    record.role = role;
    record.content = content;
    record.createdAt = QDateTime::fromMSecsSinceEpoch(timestamp, Qt::UTC).toLocalTime();
    record.stats = stats;
    return record;
}

void ChatStorage::updateMessage(const qint64 messageId, const QString &content, const GenerationStats &stats) {
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral(
        "UPDATE messages SET content=?,prompt_tokens=?,completion_tokens=?,tokens_per_second=?,generation_seconds=?,"
        "reasoning_strength=? WHERE id=?"));
    query.addBindValue(content);
    query.addBindValue(stats.promptTokens);
    query.addBindValue(stats.completionTokens);
    query.addBindValue(stats.tokensPerSecond);
    query.addBindValue(stats.elapsedSeconds);
    query.addBindValue(stats.reasoningStrength);
    query.addBindValue(messageId);
    require(query.exec(), query.lastError().text());
}

void ChatStorage::deleteMessage(const qint64 messageId) {
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral("DELETE FROM messages WHERE id=?"));
    query.addBindValue(messageId);
    require(query.exec(), query.lastError().text());
}

void ChatStorage::saveClarification(const qint64 messageId, const QString &json) {
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral("INSERT INTO clarification_cards(message_id,payload) VALUES (?,?) "
                                 "ON CONFLICT(message_id) DO UPDATE SET payload=excluded.payload"));
    query.addBindValue(messageId);
    query.addBindValue(json);
    require(query.exec(), query.lastError().text());
}

SummaryRecord ChatStorage::summary(const qint64 conversationId) const {
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral("SELECT conversation_id,through_message_id,content,token_estimate FROM summaries WHERE conversation_id=?"));
    query.addBindValue(conversationId);
    require(query.exec(), query.lastError().text());
    SummaryRecord record;
    record.conversationId = conversationId;
    if (!query.next()) {
        return record;
    }
    record.conversationId = query.value(0).toLongLong();
    record.throughMessageId = query.value(1).toLongLong();
    record.content = query.value(2).toString();
    record.tokenEstimate = query.value(3).toInt();
    return record;
}

void ChatStorage::saveSummary(const SummaryRecord &summary) {
    QSqlQuery query(m_database);
    query.prepare(QStringLiteral(
        "INSERT INTO summaries(conversation_id,through_message_id,content,token_estimate,updated_at) VALUES(?,?,?,?,?) "
        "ON CONFLICT(conversation_id) DO UPDATE SET through_message_id=excluded.through_message_id,content=excluded.content,"
        "token_estimate=excluded.token_estimate,updated_at=excluded.updated_at"));
    query.addBindValue(summary.conversationId);
    query.addBindValue(summary.throughMessageId);
    query.addBindValue(summary.content);
    query.addBindValue(summary.tokenEstimate);
    query.addBindValue(nowUtcMillis());
    require(query.exec(), query.lastError().text());
}
