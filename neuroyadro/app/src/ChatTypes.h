#pragma once

#include <QDateTime>
#include <QMetaType>
#include <QString>
#include <QVariantList>
#include <QVector>

struct ConversationRecord {
    qint64 id = -1;
    QString title;
    QString preview;
    QDateTime createdAt;
    QDateTime updatedAt;
};

struct GenerationStats {
    int promptTokens = 0;
    int completionTokens = 0;
    double tokensPerSecond = 0.0;
    double elapsedSeconds = 0.0;
    int reasoningStrength = 0;
};

struct MessageRecord {
    qint64 id = -1;
    qint64 conversationId = -1;
    QString role;
    QString content;
    QDateTime createdAt;
    GenerationStats stats;
    bool streaming = false;
    QVariantList clarification;
};

struct SummaryRecord {
    qint64 conversationId = -1;
    qint64 throughMessageId = -1;
    QString content;
    int tokenEstimate = 0;
};

Q_DECLARE_METATYPE(GenerationStats)
