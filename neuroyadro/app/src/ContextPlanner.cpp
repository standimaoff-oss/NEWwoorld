#include "ContextPlanner.h"

#include <QtMath>

namespace {
QString roleName(const QString &role) {
    if (role == QStringLiteral("user")) {
        return QStringLiteral("Пользователь");
    }
    if (role == QStringLiteral("assistant")) {
        return QStringLiteral("НейроЯдро");
    }
    return QStringLiteral("Система");
}
}

QString ContextPlanner::systemPrompt() {
    return QStringLiteral(
        "Ты НейроЯдро, локальный русскоязычный ИИ-помощник. Отвечай честно, ясно и по существу. "
        "Не выдумывай источники, факты или выполненные действия. Если запрос неоднозначен и это мешает ответу, "
        "можешь вернуть только JSON-объект формата {\"clarify\":[{\"question\":...,\"options\":[...],"
        "\"allow_custom\":true,\"skippable\":true}]}; вопросов не больше трёх, вариантов не больше трёх. "
        "Не повторяй прежний ответ дословно. Внутренние черновики и скрытые рассуждения не показывай: дай только "
        "проверяемый вывод и краткие необходимые пояснения.");
}

int ContextPlanner::estimateTokens(const QString &text) {
    // Conservative client-side estimate. The GGUF tokenizer remains the authority at generation time.
    return qMax(1, qCeil(static_cast<double>(text.size()) / 2.8));
}

QString ContextPlanner::transcript(const QVector<MessageRecord> &messages) {
    QStringList lines;
    for (const MessageRecord &message : messages) {
        lines.append(QStringLiteral("%1: %2").arg(roleName(message.role), message.content.trimmed()));
    }
    return lines.join(QStringLiteral("\n\n"));
}

QString ContextPlanner::assistantPrompt(const QVector<MessageRecord> &messages, const SummaryRecord &summary) {
    QStringList sections{QStringLiteral("Система:\n%1").arg(systemPrompt())};
    if (!summary.content.trimmed().isEmpty()) {
        sections.append(QStringLiteral("Краткое резюме ранней части диалога:\n%1").arg(summary.content.trimmed()));
    }
    if (!messages.isEmpty()) {
        sections.append(transcript(messages));
    }
    sections.append(QStringLiteral("НейроЯдро:"));
    return sections.join(QStringLiteral("\n\n"));
}

ContextPlan ContextPlanner::plan(const QVector<MessageRecord> &allMessages, const SummaryRecord &summary,
                                 const int contextTokens, const int responseReserveTokens) {
    ContextPlan result;
    const int available = qMax(128, contextTokens - responseReserveTokens);
    QVector<MessageRecord> active;
    for (const MessageRecord &message : allMessages) {
        if (message.id > summary.throughMessageId) {
            active.append(message);
        }
    }
    result.prompt = assistantPrompt(active, summary);
    if (estimateTokens(result.prompt) <= available) {
        return result;
    }

    // Keep the last two turns in original form. Everything before them is a candidate for local summarization.
    const int activeCount = static_cast<int>(active.size());
    const int keepAtLeast = qMin(4, activeCount);
    const int movable = activeCount - keepAtLeast;
    if (movable <= 0) {
        result.fits = false;
        return result;
    }
    for (int index = 0; index < movable; ++index) {
        result.messagesToSummarize.append(active.at(index));
    }
    QVector<MessageRecord> retained;
    for (int index = movable; index < activeCount; ++index) {
        retained.append(active.at(index));
    }
    result.summaryThroughMessageId = result.messagesToSummarize.constLast().id;
    const QString previous = summary.content.trimmed().isEmpty()
        ? QStringLiteral("Ранней сводки нет.") : summary.content.trimmed();
    result.summaryPrompt = QStringLiteral(
        "Составь короткую фактическую сводку диалога для продолжения разговора. Сохрани цели пользователя, "
        "решения, ограничения, данные и открытые вопросы. Не добавляй новых фактов, не отвечай на исходный запрос, "
        "не раскрывай внутренние рассуждения. До 180 токенов.\n\nПредыдущая сводка:\n%1\n\nНовые сообщения:\n%2\n\nСводка:")
        .arg(previous, transcript(result.messagesToSummarize));

    SummaryRecord projected = summary;
    projected.throughMessageId = result.summaryThroughMessageId;
    projected.content = QStringLiteral("[Резюме готовится локальной моделью]");
    result.prompt = assistantPrompt(retained, projected);
    if (estimateTokens(result.prompt) > available) {
        result.fits = false;
    }
    return result;
}
