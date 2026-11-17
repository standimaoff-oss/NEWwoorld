#pragma once

#include "ChatTypes.h"

#include <QVector>

struct ContextPlan {
    QString prompt;
    QVector<MessageRecord> messagesToSummarize;
    QString summaryPrompt;
    qint64 summaryThroughMessageId = -1;
    bool fits = true;
};

class ContextPlanner final {
public:
    static QString systemPrompt();
    static int estimateTokens(const QString &text);
    static ContextPlan plan(const QVector<MessageRecord> &messages, const SummaryRecord &summary,
                            int contextTokens, int responseReserveTokens);

private:
    static QString transcript(const QVector<MessageRecord> &messages);
    static QString assistantPrompt(const QVector<MessageRecord> &messages, const SummaryRecord &summary);
};
